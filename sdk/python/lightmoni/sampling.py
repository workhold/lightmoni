"""Validated snapshots and the shared Go/TypeScript log selection algorithm."""
import json
import math
import re
from decimal import Decimal

SYSTEM_TABLES = frozenset(("lightmoni_center", "lightmoni_agent", "lightmoni_sdk"))
_FIELDS = frozenset(("event_id", "service", "severity", "trace_id", "instance_id", "sdk.language"))
_SDK_FIELDS = frozenset(("service", "instance_id", "sdk.language"))


def _object(value, allowed):
    if not isinstance(value, dict) or value.keys() - allowed:
        raise ValueError("invalid reporting rule fields")


def _text(value, maximum, nonempty=False):
    return isinstance(value, str) and (bool(value) or not nonempty) and len(value.encode()) <= maximum


def _field(value):
    return (_text(value, 136, True) and "\0" not in value
            and (value in _FIELDS or value.startswith("attr:") and len(value) > 5
                 or value.startswith("resource:") and len(value) > 9))


def scalar_token(value):
    if isinstance(value, str):
        return "s:" + value
    if type(value) is bool:
        return "b:true" if value else "b:false"
    if type(value) is int:
        return "n:" + str(value)
    if type(value) is float and math.isfinite(value):
        text = format(Decimal(str(value)), "f")
        if "." in text:
            text = text.rstrip("0").rstrip(".")
        return "n:" + ("0" if value == 0 else text)
    raise ValueError("reporting values require string, boolean or finite number")


def _conditions(value, sdk=False):
    if not isinstance(value, list) or len(value) > 8:
        raise ValueError("at most eight reporting conditions")
    result = []
    for condition in value:
        _object(condition, {"field", "operator", "values"})
        field, operator, values = condition.get("field"), condition.get("operator"), condition.get("values", [])
        if not _field(field) or operator not in ("in", "exists") or not isinstance(values, list):
            raise ValueError("invalid reporting condition")
        if sdk and field not in _SDK_FIELDS and not field.startswith("resource:"):
            raise ValueError("invalid SDK stop selector")
        if operator == "exists":
            if values:
                raise ValueError("exists requires no values")
        else:
            if not 1 <= len(values) <= 256:
                raise ValueError("in requires one to 256 scalar values")
            for item in values:
                scalar_token(item)
        result.append({"field": field, "operator": operator, "values": list(values)})
    return result


def copy_exclusions(value, sdk=False):
    if not isinstance(value, list) or len(value) > 32:
        raise ValueError("at most 32 exclusion rules")
    result = []
    for rule in value:
        _object(rule, {"name", "conditions"})
        name = rule.get("name", "")
        if not _text(name, 64):
            raise ValueError("invalid exclusion name")
        conditions = _conditions(rule.get("conditions"), sdk)
        if not conditions:
            raise ValueError("exclusion requires a condition")
        result.append({"name": name, "conditions": conditions})
    return result


def copy_policy(value):
    _object(value, {"key", "rules", "exclude"})
    key, rules = value.get("key", "event_id"), value.get("rules")
    if not _field(key) or not isinstance(rules, list) or len(rules) > 32:
        raise ValueError("invalid log policy key or rules")
    result = {"key": key, "rules": [], "exclude": copy_exclusions(value.get("exclude", []))}
    for rule in rules:
        _object(rule, {"name", "rate", "conditions"})
        name, rate = rule.get("name", ""), rule.get("rate")
        if (not _text(name, 64) or type(rate) not in (int, float) or not 0 <= rate <= 1
                or rate != 0 and rate < 0.000001):
            raise ValueError("invalid log rule name or rate")
        result["rules"].append({"name": name, "rate": rate, "conditions": _conditions(rule.get("conditions"))})
    if len(json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()) > 64 << 10:
        raise ValueError("log policy exceeds 64 KiB")
    return result


def copy_policies(value):
    if not isinstance(value, dict) or len(value) > 200:
        raise ValueError("invalid log policy map")
    result = {}
    for table, policy in value.items():
        if (not isinstance(table, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,47}", table)
                or table.startswith(("log_", "metric_", "trace_")) or table in SYSTEM_TABLES):
            raise ValueError("invalid log policy table")
        result[table] = copy_policy(policy)
    return result


def decode_config(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate configuration field")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise ValueError("non-finite configuration number")

    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    _object(value, {"revision", "log_sampling", "disable_rules"})
    if not _text(value.get("revision"), 128, True):
        raise ValueError("invalid SDK configuration revision")
    return {"revision": value["revision"], "log_sampling": copy_policies(value.get("log_sampling")),
            "disable_rules": copy_exclusions(value.get("disable_rules", []), sdk=True)}


def _value(field, record, attributes, resource):
    if field.startswith("attr:"):
        return attributes.get(field[5:])
    if field.startswith("resource:"):
        return resource.get(field[9:])
    value = record.get(field)
    return None if field == "trace_id" and value == "" else value


def matches(conditions, record, attributes, resource):
    for condition in conditions:
        value = _value(condition["field"], record, attributes, resource)
        if value is None:
            return False
        if condition["operator"] == "in":
            try:
                token = scalar_token(value)
            except ValueError:
                return False
            if not any(token == scalar_token(expected) for expected in condition["values"]):
                return False
    return True


def sample_log(policy, table, record, attributes, resource):
    if any(matches(rule["conditions"], record, attributes, resource) for rule in policy["exclude"]):
        return False, 0, "excluded"
    rate, reason = -1, "unmatched"
    for rule in policy["rules"]:
        if rule["rate"] > rate and matches(rule["conditions"], record, attributes, resource):
            rate, reason = rule["rate"], rule["name"] or "matched"
    if rate <= 0:
        return False, 0, reason
    field = policy["key"]
    value = _value(field, record, attributes, resource)
    try:
        if value is None or value == "":
            raise ValueError("missing sampling key")
        token = scalar_token(value)
    except ValueError:
        field, token = "event_id", scalar_token(record["event_id"])
    hashed = 2166136261
    for byte in ("lightmoni-log-rules\0" + table + "\0" + field + "\0" + token).encode():
        hashed = ((hashed ^ byte) * 16777619) & 0xffffffff
    hashed ^= hashed >> 16
    hashed = (hashed * 0x85ebca6b) & 0xffffffff
    hashed ^= hashed >> 13
    hashed = (hashed * 0xc2b2ae35) & 0xffffffff
    hashed ^= hashed >> 16
    return hashed / 2**32 < rate, rate, reason
