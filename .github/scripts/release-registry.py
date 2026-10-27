#!/usr/bin/env python3
"""Prepare and publish dual-platform images without a local Docker daemon.

Usage is identical to registry.py: prepare|publish --root DIR --revision FULL_SHA.
The publish action waits for DIR/ready-to-publish before writing the registry.
Credentials stay in memory. Verification performs independent OCI HTTP reads;
it never invokes Docker and does not claim a docker pull or container execution.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import getpass
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request


BASE = "https://docker.heyphp.com"
REPOSITORY = "lightmoni/lightmoni"
USERNAME = "liminghan"
FIXED_TAG = "20261027-operations"
ARCHES = ("amd64", "arm64")
CHUNK_SIZE = 512 * 1024
MAX_BLOB_WORKERS = 6
UPLOAD_PROGRESS_BYTES = 8 * 1024 * 1024
UPLOAD_PROGRESS_SECONDS = 30
UPLOAD_TIMEOUT = 600
READ_TIMEOUT = 600
METADATA_LIMIT = 16 << 20
INDEX_MEDIA = "application/vnd.oci.image.index.v1+json"
MANIFEST_MEDIA = "application/vnd.docker.distribution.manifest.v2+json"
CONFIG_MEDIA = "application/vnd.docker.container.image.v1+json"
LAYER_MEDIA = "application/vnd.docker.image.rootfs.diff.tar.gzip"
ACCEPT_MANIFEST = ", ".join((INDEX_MEDIA,
    "application/vnd.docker.distribution.manifest.list.v2+json", MANIFEST_MEDIA,
    "application/vnd.oci.image.manifest.v1+json"))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def valid_digest(value):
    require(isinstance(value, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", value),
        "Invalid SHA256 descriptor")
    return value


def descriptor(value):
    require(isinstance(value, dict), "Invalid OCI descriptor")
    valid_digest(value.get("digest"))
    require(type(value.get("size")) is int and value["size"] >= 0,
        "Invalid OCI descriptor size")
    return value


def blobpath(root, value):
    return root / "blobs" / valid_digest(value).split(":", 1)[1]


def putblob(root, data):
    value = digest(data)
    target = blobpath(root, value)
    target.parent.mkdir(exist_ok=True)
    target.write_bytes(data)
    return value


def write_report(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    path.chmod(0o600)


def independent_blobs(worker, values):
    """Bound independent blob transfers; never replay a failed/uncertain write."""
    with ThreadPoolExecutor(max_workers=MAX_BLOB_WORKERS) as executor:
        futures = [executor.submit(worker, value) for value in values]
        try:
            return [future.result() for future in as_completed(futures)]
        except BaseException:
            # Running transfers may finish their own isolated blob; queued
            # transfers are cancelled. No manifest/tag write follows a failure.
            for future in futures:
                future.cancel()
            raise


def unique_blob(inventory, value):
    value = descriptor(value)
    previous = inventory.get(value["digest"])
    require(previous is None or (previous["size"] == value["size"]
        and previous.get("mediaType") == value.get("mediaType")),
        "Conflicting descriptors for the same blob digest")
    inventory[value["digest"]] = value


def prepare(root, revision):
    report = {"source_revision": revision, "repository": "docker.heyphp.com/" + REPOSITORY,
        "platforms": []}
    for arch in ARCHES:
        # Build outputs may have a .tar suffix while being gzip-compressed.
        with tarfile.open(root / (arch + ".tar"), mode="r:*") as archive:
            entries = json.load(archive.extractfile("manifest.json"))
            require(isinstance(entries, list) and len(entries) == 1, "Expected one saved image per architecture")
            item = entries[0]
            raw = archive.extractfile(item["Config"]).read()
            config = json.loads(raw)
            require(config["architecture"] == arch and config["os"] == "linux", "Saved image architecture mismatch")
            require(config["config"]["Labels"]["org.opencontainers.image.revision"] == revision,
                "Saved image source revision mismatch")
            require(config["config"]["User"] == "lightmoni", "Saved image runtime user mismatch")
            config_digest = putblob(root, raw)
            layers = []
            diffs = config["rootfs"]["diff_ids"]
            require(len(diffs) == len(item["Layers"]), "Saved image layer inventory mismatch")
            for index, name in enumerate(item["Layers"]):
                stream = archive.extractfile(name)
                require(stream is not None, "Saved image layer missing")
                with stream:
                    prefix = stream.read(2)
                    temporary = root / "layer.tmp"
                    plain_hash = hashlib.sha256()
                    if prefix == b"\x1f\x8b":
                        with temporary.open("wb") as output:
                            output.write(prefix)
                            shutil.copyfileobj(stream, output)
                        with gzip.open(temporary, "rb") as plain:
                            while chunk := plain.read(1 << 20):
                                plain_hash.update(chunk)
                    else:
                        with temporary.open("wb") as output:
                            with gzip.GzipFile(fileobj=output, mode="wb", compresslevel=3, mtime=0) as compressed:
                                plain_hash.update(prefix)
                                compressed.write(prefix)
                                while chunk := stream.read(1 << 20):
                                    plain_hash.update(chunk)
                                    compressed.write(chunk)
                require("sha256:" + plain_hash.hexdigest() == diffs[index], "Saved image layer diff_id mismatch")
                compressed_hash = hashlib.sha256()
                with temporary.open("rb") as source:
                    while chunk := source.read(1 << 20):
                        compressed_hash.update(chunk)
                value = "sha256:" + compressed_hash.hexdigest()
                size = temporary.stat().st_size
                target = blobpath(root, value)
                if target.exists():
                    temporary.unlink()
                else:
                    temporary.rename(target)
                layers.append({"mediaType": LAYER_MEDIA, "size": size, "digest": value})
            manifest = {"schemaVersion": 2, "mediaType": MANIFEST_MEDIA,
                "config": {"mediaType": CONFIG_MEDIA, "size": len(raw), "digest": config_digest}, "layers": layers}
            body = json.dumps(manifest, separators=(",", ":")).encode()
            (root / (arch + "-manifest.json")).write_bytes(body)
            report["platforms"].append({"platform": "linux/" + arch, "digest": digest(body),
                "size": len(body), "config_digest": config_digest, "layer_count": len(layers),
                "runtime_user": config["config"]["User"]})
            print("Prepared", arch, len(layers), "layers", flush=True)
    index = {"schemaVersion": 2, "mediaType": INDEX_MEDIA, "manifests": [
        {"mediaType": MANIFEST_MEDIA, "digest": item["digest"], "size": item["size"],
            "platform": {"architecture": item["platform"].split("/")[1], "os": "linux"}}
        for item in report["platforms"]]}
    body = json.dumps(index, separators=(",", ":")).encode()
    (root / "index.json").write_bytes(body)
    report["index_digest"] = digest(body)
    write_report(root / "prepared-report.json", report)
    print("Prepared index", report["index_digest"], flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def opener():
    # Do not inherit proxy or cookie state, and never follow redirects implicitly.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def https_url(value, relative_to=BASE):
    require(isinstance(value, str) and not any(ord(char) <= 32 or ord(char) == 127 for char in value),
        "Invalid registry URL")
    url = urllib.parse.urljoin(relative_to, value)
    parsed = urllib.parse.urlsplit(url)
    try:
        valid_port = parsed.port is None or 1 <= parsed.port <= 65535
    except ValueError:
        valid_port = False
    require(parsed.scheme == "https" and parsed.hostname and valid_port
        and parsed.username is None and parsed.password is None and not parsed.fragment,
        "Registry URL requires HTTPS without embedded credentials")
    return url, parsed


def same_origin(parsed):
    return parsed.scheme == "https" and parsed.hostname.lower() == "docker.heyphp.com" and parsed.port in (None, 443)


def header(headers, name):
    return next((value for key, value in headers.items() if key.lower() == name.lower()), None)


def read_metadata(response):
    body = response.read(METADATA_LIMIT + 1)
    require(len(body) <= METADATA_LIMIT, "Registry metadata exceeded its size limit")
    return body


class RegistryClient:
    def __init__(self, authorization):
        self.authorization = authorization
        self.opener = opener()

    def request(self, method, path, data=None, headers=None, allowed=()):
        url, parsed = https_url(path)
        require(same_origin(parsed), "Registry write or authenticated request left the authorized origin")
        supplied = headers or {}
        require(all(key.lower() in {"accept", "content-type", "content-range"} for key in supplied),
            "Unexpected registry request header")
        outgoing = {"Authorization": self.authorization, **supplied}
        request = urllib.request.Request(url, data=data, headers=outgoing, method=method)
        try:
            response = self.opener.open(request, timeout=UPLOAD_TIMEOUT)
        except urllib.error.HTTPError as error:
            if error.code not in allowed:
                error.close()
                raise RuntimeError("Registry " + method + " returned HTTP " + str(error.code)) from None
            response = error
        except (urllib.error.URLError, TimeoutError, OSError):
            # Never replay POST/PATCH/PUT after an uncertain write. A fresh run
            # may reuse only fully committed blobs that pass registry HEAD.
            raise RuntimeError("Registry " + method + " failed; no automatic write retry was attempted") from None
        try:
            with response:
                return response.code, dict(response.headers), read_metadata(response)
        except (urllib.error.URLError, TimeoutError, OSError):
            raise RuntimeError("Registry " + method + " response failed; no automatic write retry was attempted") from None

    def upload(self, root, value):
        value = valid_digest(value)
        path = "/v2/" + REPOSITORY + "/blobs/" + value
        status, _, _ = self.request("HEAD", path, allowed=(404,))
        if status == 200:
            return
        status, headers, _ = self.request("POST", "/v2/" + REPOSITORY + "/blobs/uploads/", b"",
            {"Content-Type": "application/octet-stream"})
        require(status == 202, "Registry did not create a blob upload")
        location = header(headers, "location")
        require(location, "Registry upload location missing")
        source = blobpath(root, value)
        source_size = source.stat().st_size
        offset = 0
        started = time.monotonic()
        last_progress = started
        next_progress = UPLOAD_PROGRESS_BYTES
        with source.open("rb") as handle:
            while chunk := handle.read(CHUNK_SIZE):
                status, headers, _ = self.request("PATCH", location, chunk,
                    {"Content-Type": "application/octet-stream", "Content-Range": str(offset) + "-" + str(offset + len(chunk) - 1)})
                require(status == 202, "Registry did not accept the blob chunk")
                location = header(headers, "location") or location
                offset += len(chunk)
                now = time.monotonic()
                if offset >= next_progress or now - last_progress >= UPLOAD_PROGRESS_SECONDS or offset == source_size:
                    print("Blob upload progress", value[:23], "offset", offset,
                        "elapsed_seconds", round(now - started, 1), flush=True)
                    next_progress = (offset // UPLOAD_PROGRESS_BYTES + 1) * UPLOAD_PROGRESS_BYTES
                    last_progress = now
        location += ("&" if "?" in location else "?") + urllib.parse.urlencode({"digest": value})
        status, _, _ = self.request("PUT", location, b"", {"Content-Type": "application/octet-stream"})
        require(status == 201, "Registry did not commit the uploaded blob")
        require(self.request("HEAD", path)[0] == 200, "Committed blob unavailable")
        print("Uploaded blob", value[:23], source.stat().st_size, flush=True)


class IndependentOCIReader:
    """Fresh, read-only HTTP client; no Docker CLI, upload state, or local blobs."""
    def __init__(self, authorization):
        self.authorization = authorization
        self.opener = opener()

    def open(self, path, blob=False):
        url, parsed = https_url(path)
        require(same_origin(parsed), "Independent OCI read must begin at the authorized registry")
        credentials_allowed = True
        for hop in range(6):
            # Each hop builds a new minimal header map. No response header,
            # cookie, upload header, or previous Request header is forwarded.
            outgoing = {}
            if credentials_allowed and same_origin(parsed):
                outgoing["Authorization"] = self.authorization
            if not blob:
                outgoing["Accept"] = ACCEPT_MANIFEST
            request = urllib.request.Request(url, headers=outgoing, method="GET")
            try:
                return self.opener.open(request, timeout=READ_TIMEOUT)
            except urllib.error.HTTPError as error:
                if not blob or error.code not in (301, 302, 303, 307, 308):
                    error.close()
                    raise RuntimeError("Independent OCI GET returned HTTP " + str(error.code)) from None
                location = error.headers.get("Location")
                error.close()
                require(location and hop < 5, "Blob redirect missing or exceeded its hop limit")
                previous_origin = (parsed.scheme, parsed.hostname.lower(), parsed.port or 443)
                url, parsed = https_url(location, url)
                current_origin = (parsed.scheme, parsed.hostname.lower(), parsed.port or 443)
                if current_origin != previous_origin:
                    credentials_allowed = False
            except (urllib.error.URLError, TimeoutError, OSError):
                raise RuntimeError("Independent OCI GET failed") from None
        raise RuntimeError("Blob redirect exceeded its hop limit")

    def metadata(self, reference, expected_digest, expected_size=None):
        valid_digest(expected_digest)
        with self.open("/v2/" + REPOSITORY + "/manifests/" + reference) as response:
            body = read_metadata(response)
        require(digest(body) == expected_digest, "Independent OCI manifest digest mismatch")
        if expected_size is not None:
            require(len(body) == expected_size, "Independent OCI manifest size mismatch")
        return json.loads(body)

    def blob(self, value, collect=False):
        value = descriptor(value)
        require(not collect or value["size"] <= METADATA_LIMIT, "OCI config exceeds its size limit")
        checksum, size, chunks = hashlib.sha256(), 0, []
        with self.open("/v2/" + REPOSITORY + "/blobs/" + value["digest"], blob=True) as response:
            length = response.headers.get("Content-Length")
            if length is not None:
                require(length.isdecimal() and int(length) == value["size"], "Independent OCI blob Content-Length mismatch")
            try:
                while chunk := response.read(1 << 20):
                    size += len(chunk)
                    require(size <= value["size"], "Independent OCI blob exceeded its descriptor size")
                    checksum.update(chunk)
                    if collect:
                        chunks.append(chunk)
            except (urllib.error.URLError, TimeoutError, OSError):
                raise RuntimeError("Independent OCI blob stream failed") from None
        require(size == value["size"] and "sha256:" + checksum.hexdigest() == value["digest"],
            "Independent OCI blob digest or size mismatch")
        return b"".join(chunks) if collect else size

    def verify(self, revision, expected_index_digest):
        # Independently GET both tags after both writes have completed. Pull
        # each descriptor chain once since both tags must resolve to this index.
        index = self.metadata(FIXED_TAG, expected_index_digest)
        latest = self.metadata("latest", expected_index_digest)
        require(index == latest and index.get("schemaVersion") == 2 and index.get("mediaType") == INDEX_MEDIA,
            "Independent OCI index mismatch")
        manifests = index.get("manifests")
        require(isinstance(manifests, list) and len(manifests) == 2, "Expected a two-platform OCI index")
        seen, results, pending = set(), [], []
        unique_layers = {}
        for entry in manifests:
            entry = descriptor(entry)
            platform = entry.get("platform", {})
            arch = platform.get("architecture")
            require(platform.get("os") == "linux" and arch in ARCHES and arch not in seen,
                "Independent OCI index platform mismatch")
            seen.add(arch)
            manifest = self.metadata(entry["digest"], entry["digest"], entry["size"])
            require(manifest.get("schemaVersion") == 2 and manifest.get("mediaType") == MANIFEST_MEDIA,
                "Independent OCI image manifest mismatch")
            config_descriptor = descriptor(manifest.get("config"))
            config = json.loads(self.blob(config_descriptor, collect=True))
            require(config.get("os") == "linux" and config.get("architecture") == arch,
                "Independent OCI config platform mismatch")
            settings = config.get("config", {})
            require(settings.get("Labels", {}).get("org.opencontainers.image.revision") == revision
                and settings.get("User") == "lightmoni", "Independent OCI config revision or runtime user mismatch")
            layers = manifest.get("layers")
            require(isinstance(layers, list) and len(layers) == len(config.get("rootfs", {}).get("diff_ids", [])),
                "Independent OCI layer inventory mismatch")
            for layer in layers:
                require(descriptor(layer).get("mediaType") == LAYER_MEDIA, "Unexpected OCI layer media type")
                unique_blob(unique_layers, layer)
            pending.append((arch, entry, config_descriptor, layers))
        require(seen == set(ARCHES), "Independent OCI verification missed an architecture")

        def read_layer(layer):
            # No shared opener/redirect state between workers. Every transfer
            # independently hashes its entire response against its descriptor.
            size = IndependentOCIReader(self.authorization).blob(layer)
            print("OCI layer verified", layer["digest"][:23], size, flush=True)
            return layer["digest"], size

        verified_sizes = dict(independent_blobs(read_layer,
            sorted(unique_layers.values(), key=lambda item: item["size"], reverse=True)))
        for arch, entry, config_descriptor, layers in pending:
            total = sum(verified_sizes[layer["digest"]] for layer in layers)
            results.append({"platform": "linux/" + arch, "manifest_digest": entry["digest"],
                "config_digest": config_descriptor["digest"], "layer_count": len(layers),
                "compressed_layer_bytes": total, "verified_tags": [FIXED_TAG, "latest"]})
            print("Independent OCI pull verified", arch, flush=True)
        return results


def publish(root, revision):
    password = os.environ.pop("LIGHTMONI_RELEASE_REGISTRY_PASSWORD", None)
    if password is None:
        password = getpass.getpass("Registry password (ephemeral): ")
    require(bool(password), "Registry password unavailable")
    authorization = "Basic " + base64.b64encode((USERNAME + ":" + password).encode()).decode()
    del password
    client = RegistryClient(authorization)
    require(client.request("GET", "/v2/")[0] == 200, "Registry authorization unavailable")
    print("Registry authorization verified; waiting for successful release validation", flush=True)
    while not (root / "ready-to-publish").exists():
        time.sleep(2)
    report = json.loads((root / "prepared-report.json").read_text())
    require(report.get("source_revision") == revision, "Prepared source revision mismatch")
    index_body = (root / "index.json").read_bytes()
    expected_index = valid_digest(report.get("index_digest"))
    require(digest(index_body) == expected_index, "Prepared index digest mismatch")
    report["tags"] = []
    status, _, previous = client.request("GET", "/v2/" + REPOSITORY + "/manifests/latest",
        headers={"Accept": ACCEPT_MANIFEST}, allowed=(404,))
    report["previous_latest_digest"] = digest(previous) if status == 200 else None
    status, _, previous = client.request("GET", "/v2/" + REPOSITORY + "/manifests/" + FIXED_TAG,
        headers={"Accept": INDEX_MEDIA}, allowed=(404,))
    require(status != 200 or digest(previous) == expected_index, "Refusing to overwrite an existing fixed tag")
    manifests, upload_blobs = [], {}
    for arch in ARCHES:
        body = (root / (arch + "-manifest.json")).read_bytes()
        manifest = json.loads(body)
        require(manifest.get("mediaType") == MANIFEST_MEDIA, "Unexpected prepared image manifest")
        for entry in [manifest["config"], *manifest["layers"]]:
            unique_blob(upload_blobs, entry)
        manifests.append(body)

    def upload_blob(entry):
        # Each blob has its own upload session, offset and HTTP opener. A shared
        # content digest is submitted only once across both architectures.
        RegistryClient(authorization).upload(root, entry["digest"])

    print("Queued unique blobs", len(upload_blobs), "compressed_bytes",
        sum(item["size"] for item in upload_blobs.values()), "workers", MAX_BLOB_WORKERS, flush=True)
    independent_blobs(upload_blob,
        sorted(upload_blobs.values(), key=lambda item: item["size"], reverse=True))
    # All independent blobs must succeed before any manifest or tag is written.
    # These references remain deliberately sequential, including both existing
    # fixed-tag overwrite checks and the final readback.
    for body in manifests:
        status, _, _ = client.request("PUT", "/v2/" + REPOSITORY + "/manifests/" + digest(body),
            body, {"Content-Type": MANIFEST_MEDIA})
        require(status == 201, "Registry did not store the image manifest")
    for name in (FIXED_TAG, "latest"):
        # Repeat the fixed-tag check immediately before its write. The registry
        # has no atomic compare-and-put API; another publisher must not race it.
        if name != "latest":
            status, _, previous = client.request("GET", "/v2/" + REPOSITORY + "/manifests/" + name,
                headers={"Accept": INDEX_MEDIA}, allowed=(404,))
            require(status != 200 or digest(previous) == expected_index,
                "Refusing to overwrite an existing fixed tag")
        status, _, _ = client.request("PUT", "/v2/" + REPOSITORY + "/manifests/" + name,
            index_body, {"Content-Type": INDEX_MEDIA})
        require(status == 201, "Registry did not store the image tag")
        _, _, readback = client.request("GET", "/v2/" + REPOSITORY + "/manifests/" + name,
            headers={"Accept": INDEX_MEDIA})
        require(readback == index_body, "Published tag readback mismatch")
        report["tags"].append({"tag": name, "digest": digest(readback)})
        print("Published and verified", name, digest(readback), flush=True)
    reader = IndependentOCIReader(authorization)
    report["independent_oci_pull_details"] = reader.verify(revision, expected_index)
    report["independent_oci_pull_verified"] = [item["platform"] for item in report["independent_oci_pull_details"]]
    report["verification_method"] = "Independent OCI HTTP GET: index, image manifests, configs and every streamed layer digest/size"
    report["docker_pull_executed"] = False
    report["container_execution_verified"] = False
    report["limitations"] = ["This is an independent OCI distribution pull verification; no Docker pull or container execution was performed"]
    write_report(root / "registry-report.json", report)
    print("Registry report saved; verification used OCI HTTP reads without Docker", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "publish"))
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    require(args.root.is_dir(), "Working root must already exist")
    require(re.fullmatch(r"[0-9a-f]{40}", args.revision), "Expected a full lowercase source SHA")
    os.umask(0o077)
    if args.action == "prepare":
        prepare(args.root, args.revision)
    else:
        publish(args.root, args.revision)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit("Cancelled") from None
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
    except Exception as error:
        # Never print raw HTTP errors, redirect locations or arbitrary responses.
        raise SystemExit("Registry operation failed: " + type(error).__name__) from None
