#!/usr/bin/env python3
"""Offline, read-only download verification for two Docker-save archives.

Place amd64.tar and arm64.tar beside this script, then run it with Python 3.
No archive member is extracted. Layers are read as streams. This is deliberately
not a general overlay implementation: any whiteout, link, or non-directory
ancestor affecting /opt/lightmoni/runtime/downloads is explicitly rejected.
Only public download metadata and selected image identity fields are reported;
the image environment, raw config, layer contents, and errors are never printed.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
from typing import BinaryIO


ROOT = Path(__file__).resolve().parent
DOWNLOADS = "opt/lightmoni/runtime/downloads"
CHUNK = 2 * 1024 * 1024
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_CHECKSUM_BYTES = 128 * 1024
ARCHITECTURES = ("amd64", "arm64")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
REVISION = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?\Z")
PUBLIC_FILENAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,240}\Z")
IMAGE_USER = re.compile(r"(?:[A-Za-z_][A-Za-z0-9_.-]*|[0-9]+)(?::(?:[A-Za-z_][A-Za-z0-9_.-]*|[0-9]+))?\Z")


class InspectionError(Exception):
    """The fixed code is safe to include in a public report."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def require(condition: object, code: str) -> None:
    if not condition:
        raise InspectionError(code)


def normalized_path(name: str) -> str:
    require(isinstance(name, str) and "\x00" not in name and "\\" not in name, "unsafe_archive_path")
    while name.startswith("./"):
        name = name[2:]
    name = name.rstrip("/")
    require(not name.startswith("/"), "absolute_archive_path")
    parts = PurePosixPath(name).parts
    require(".." not in parts, "parent_archive_path")
    return "/".join(part for part in parts if part not in ("", "."))


def overlaps_downloads(path: str) -> bool:
    return not path or path == DOWNLOADS or path.startswith(DOWNLOADS + "/") or DOWNLOADS.startswith(path + "/")


def reject_relevant_whiteout(path: str) -> None:
    parent, _, name = path.rpartition("/")
    if name == ".wh..wh..opq":
        require(not overlaps_downloads(parent), "downloads_opaque_whiteout_unsupported")
    elif name.startswith(".wh."):
        removed = "/".join(filter(None, (parent, name[4:])))
        require(not overlaps_downloads(removed), "downloads_whiteout_unsupported")


def small_bytes(stream: BinaryIO, limit: int, code: str) -> bytes:
    value = stream.read(limit + 1)
    require(len(value) <= limit, code)
    return value


def regular_member(archive: tarfile.TarFile, members: dict[str, tarfile.TarInfo], path: str) -> tarfile.TarInfo:
    require(path in members, "referenced_archive_member_missing")
    member = members[path]
    require(member.isreg(), "referenced_archive_member_not_regular")
    return member


def member_json(archive: tarfile.TarFile, member: tarfile.TarInfo):
    require(member.size <= MAX_JSON_BYTES, "image_json_too_large")
    stream = archive.extractfile(member)
    require(stream is not None, "image_json_unreadable")
    with stream:
        data = small_bytes(stream, MAX_JSON_BYTES, "image_json_too_large")
    try:
        return json.loads(data)
    except (ValueError, UnicodeError):
        raise InspectionError("image_json_invalid") from None


def digest_stream(stream: BinaryIO, expected_size: int, capture: bool) -> tuple[dict, bytes | None]:
    digest = hashlib.sha256()
    size = 0
    captured = bytearray() if capture else None
    while True:
        chunk = stream.read(CHUNK)
        if not chunk:
            break
        size += len(chunk)
        require(size <= expected_size, "download_size_overflow")
        digest.update(chunk)
        if captured is not None:
            require(size <= MAX_CHECKSUM_BYTES, "checksum_file_too_large")
            captured.extend(chunk)
    require(size == expected_size, "download_truncated")
    return {"bytes": size, "sha256": digest.hexdigest()}, bytes(captured) if captured is not None else None


def scan_layer(stream: BinaryIO, downloads: dict[str, dict]) -> int:
    found = 0
    # r|* streams uncompressed Docker-save layers and safely handles a compressed
    # layer without loading the full layer or a complete member list in memory.
    with tarfile.open(fileobj=stream, mode="r|*") as layer:
        for member in layer:
            path = normalized_path(member.name)
            reject_relevant_whiteout(path)
            if not overlaps_downloads(path):
                continue
            if path == DOWNLOADS or DOWNLOADS.startswith(path + "/") or not path:
                require(member.isdir(), "downloads_ancestor_not_directory")
                continue
            require(path.startswith(DOWNLOADS + "/"), "downloads_path_unexpected")
            relative = path[len(DOWNLOADS) + 1:]
            # Current release downloads are a flat, public directory. Reject
            # links rather than follow targets into other layer/rootfs content.
            if member.isdir():
                require(relative not in downloads, "downloads_file_replaced_by_directory")
                continue
            require(member.isreg(), "downloads_nonregular_entry_unsupported")
            require("/" not in relative and PUBLIC_FILENAME.fullmatch(relative), "downloads_filename_unexpected")
            file_stream = layer.extractfile(member)
            require(file_stream is not None, "download_unreadable")
            capture = relative in ("SHA256SUMS", "SDK_SHA256SUMS")
            with file_stream:
                details, data = digest_stream(file_stream, member.size, capture)
            downloads[relative] = {"name": relative, **details}
            if data is not None:
                downloads[relative]["checksum_contents"] = data
            found += 1
    return found


def parse_checksums(downloads: dict[str, dict], filename: str) -> dict[str, str]:
    require(filename in downloads, "checksum_file_missing")
    data = downloads[filename].get("checksum_contents")
    require(isinstance(data, bytes), "checksum_file_unreadable")
    try:
        lines = data.decode("ascii").splitlines()
    except UnicodeError:
        raise InspectionError("checksum_encoding_invalid") from None
    require(lines, "checksum_file_empty")
    entries: dict[str, str] = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-fA-F]{64})[ \t]+\*?([A-Za-z0-9][A-Za-z0-9._-]{0,240})", line)
        require(match is not None, "checksum_line_invalid")
        digest, name = match.groups()
        require(name not in entries, "checksum_duplicate_filename")
        entries[name] = digest.lower()
    return entries


def public_file(details: dict) -> dict:
    return {key: details[key] for key in ("name", "bytes", "sha256")}


def verified_files(downloads: dict[str, dict], checksums: dict[str, str]) -> list[dict]:
    output = []
    for name in sorted(checksums):
        require(name in downloads, "checksummed_download_missing")
        details = downloads[name]
        require(SHA256.fullmatch(details["sha256"]), "download_digest_invalid")
        require(details["sha256"] == checksums[name], "download_checksum_mismatch")
        require(details["bytes"] > 0, "download_empty")
        output.append({**public_file(details), "checksum_verified": True})
    return output


def inspect_image(arch: str) -> dict:
    source = ROOT / (arch + ".tar")
    require(source.is_file() and not source.is_symlink(), "docker_save_file_missing_or_link")
    downloads: dict[str, dict] = {}
    layers_with_downloads = 0
    with tarfile.open(source, mode="r:*") as archive:
        members: dict[str, tarfile.TarInfo] = {}
        for member in archive.getmembers():
            path = normalized_path(member.name)
            require(path not in members, "docker_save_duplicate_member")
            members[path] = member
        manifest = member_json(archive, regular_member(archive, members, "manifest.json"))
        require(isinstance(manifest, list) and len(manifest) == 1 and isinstance(manifest[0], dict), "docker_save_requires_one_image")
        image = manifest[0]
        config_path = image.get("Config")
        require(isinstance(config_path, str), "image_config_reference_missing")
        config_path = normalized_path(config_path)
        config = member_json(archive, regular_member(archive, members, config_path))
        require(isinstance(config, dict), "image_config_invalid")
        require(config.get("architecture") == arch and config.get("os") == "linux", "image_platform_mismatch")
        runtime_config = config.get("config")
        require(isinstance(runtime_config, dict), "image_runtime_config_invalid")
        user = runtime_config.get("User", "")
        require(isinstance(user, str) and (user == "" or IMAGE_USER.fullmatch(user)), "image_user_invalid")
        labels = runtime_config.get("Labels") or {}
        require(isinstance(labels, dict), "image_labels_invalid")
        revision = labels.get("org.opencontainers.image.revision")
        require(isinstance(revision, str) and REVISION.fullmatch(revision), "image_revision_missing_or_invalid")
        layers = image.get("Layers")
        require(isinstance(layers, list) and layers and all(isinstance(path, str) for path in layers), "image_layers_invalid")
        for layer_name in layers:
            layer_path = normalized_path(layer_name)
            layer_member = regular_member(archive, members, layer_path)
            layer_stream = archive.extractfile(layer_member)
            require(layer_stream is not None, "image_layer_unreadable")
            with layer_stream:
                found = scan_layer(layer_stream, downloads)
                if found:
                    layers_with_downloads += 1

    agents = parse_checksums(downloads, "SHA256SUMS")
    require(len(agents) == 2, "agent_checksum_count_not_two")
    versions, agent_arches = set(), set()
    for name in agents:
        match = re.fullmatch(r"lightmoni-agent_([0-9A-Za-z._-]+)_linux_(amd64|arm64)\.tar\.gz", name)
        require(match is not None, "agent_checksum_filename_invalid")
        versions.add(match[1])
        agent_arches.add(match[2])
    require(len(versions) == 1 and agent_arches == set(ARCHITECTURES), "agent_release_pair_invalid")
    version = next(iter(versions))
    sdks = parse_checksums(downloads, "SDK_SHA256SUMS")
    expected_sdks = {
        f"lightmoni-sdk-{version}.tgz",
        f"lightmoni-go-sdk_{version}.tar.gz",
        f"lightmoni-python-sdk_{version}.tar.gz",
        f"lightmoni-rust-sdk_{version}.tar.gz",
    }
    require(set(sdks) == expected_sdks, "sdk_checksum_set_not_four_supported_languages")
    require("install.sh" in downloads, "agent_installer_missing")
    return {
        "center_architecture": arch,
        "image_os": "linux",
        "image_user": user or "root (image default)",
        "image_revision": revision,
        "docker_save_filename": source.name,
        "docker_save_bytes": source.stat().st_size,
        "layers_scanned": len(layers),
        "layers_containing_downloads": layers_with_downloads,
        "release_version": version,
        "agents": verified_files(downloads, agents),
        "sdks": verified_files(downloads, sdks),
        "checksum_files": [public_file(downloads[name]) for name in ("SHA256SUMS", "SDK_SHA256SUMS")],
        "installer": public_file(downloads["install.sh"]),
        "checks_passed": {
            "both_agent_architectures_present": True,
            "all_four_sdk_languages_present": True,
            "all_six_artifact_sha256_values_verified": True,
            "no_downloads_whiteout_or_link_encountered": True,
        },
    }


def write_report(report: dict) -> None:
    temporary = ROOT / ".downloads-report.json.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(report, output, indent=2, ensure_ascii=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        destination = ROOT / "downloads-report.json"
        require(not destination.is_symlink(), "report_destination_is_link")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    report = {
        "schema_version": 1,
        "inspection": "offline Docker-save layer streams; no extraction or network",
        "scope": "packaged download bytes and checksums only; does not execute Agent or SDK",
        "images": {},
        "status": "failed",
    }
    try:
        for arch in ARCHITECTURES:
            report["images"][arch] = inspect_image(arch)
        revisions = {image["image_revision"] for image in report["images"].values()}
        versions = {image["release_version"] for image in report["images"].values()}
        require(len(revisions) == 1, "center_image_revisions_differ")
        require(len(versions) == 1, "center_image_release_versions_differ")
        # Each native image builds its own tarballs. Their valid hashes may differ
        # because archive metadata/timestamps differ, so report them per center.
        report["status"] = "passed"
    except InspectionError as error:
        report["error_code"] = error.code
    except (OSError, tarfile.TarError, ValueError, TypeError, KeyError):
        report["error_code"] = "archive_or_filesystem_inspection_failed"
    try:
        write_report(report)
    except (InspectionError, OSError):
        print("Download inspection could not write its report.", file=sys.stderr)
        return 2
    print("Download inspection " + report["status"] + "; see downloads-report.json")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
