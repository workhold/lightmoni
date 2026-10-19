"""UTC metric windows. Policies are validated before replacing a snapshot."""
import re
PERIODS = (10, 30, 60, 300, 600, 1800, 3600)
def copy_windows(value=None):
    if value is None: return {}
    if not isinstance(value, dict) or len(value)>200: raise ValueError('invalid metric windows')
    result = {}
    for table, history in value.items():
        if not re.fullmatch(r'[a-z][a-z0-9_]{0,47}', table) or not isinstance(history, list) or len(history)>256: raise ValueError('invalid metric window history')
        result[table], previous = [], -1
        for p in history:
            if not isinstance(p,dict) or set(p)!={'seconds','effective_at'} or type(p['seconds']) is not int or p['seconds'] not in PERIODS or type(p['effective_at']) is not int or p['effective_at']<0 or p['effective_at']<=previous or p['effective_at']%p['seconds']: raise ValueError('invalid metric window policy')
            previous=p['effective_at'];result[table].append(dict(p))
    return result

def window_at(policies, table, at):
    period=30
    for p in policies.get(table, []):
        if p['effective_at']<=at//1000000000: period=p['seconds']
    return at//(period*1000000000)*(period*1000000000),period
