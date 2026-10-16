package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Run the real installer with only operating-system mutations replaced by shims.
// The archive is extracted normally, and its configure process consumes the real stdin.
func TestAgentInstallerAuthenticatedDownloadsAndBufferedKey(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	zipped := gzip.NewWriter(&archive)
	writer := tar.NewWriter(zipped)
	script := "#!/bin/sh\nif [ \"$1\" = configure ]; then printf '%s\\n' \"$@\" > \"$QA_CONFIG_ARGS\"; cat > \"$QA_RECEIVED_KEY\"; fi\n"
	for name, content := range map[string]string{"lightmoni-agent": script, "lightmoni-agent.service": "[Service]\n"} {
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0755, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	artifact := "lightmoni-agent_0.1.0_linux_arm64.tar.gz"
	archivePath := filepath.Join(dir, artifact)
	manifest := filepath.Join(dir, "SHA256SUMS")
	digest := fmt.Sprintf("%x", sha256.Sum256(archive.Bytes()))
	if err := os.WriteFile(archivePath, archive.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifest, []byte(digest+"  "+artifact+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	shims := map[string]string{
		"id":        "if [ \"${1:-}\" = '-u' ]; then echo 0; fi\n",
		"uname":     "case \"$1\" in -s) echo Linux;; -m) echo aarch64;; esac\n",
		"systemctl": "exit 0\n", "install": "exit 0\n", "mv": "exit 0\n", "chown": "exit 0\n",
		"sha256sum": "printf '%s  %s\\n' \"$QA_HASH\" \"$1\"\n",
		"curl": `printf '%s\n' "$@" >> "$QA_CURL_LOG"
output=''
url=''
while [ "$#" -gt 0 ]; do
 case "$1" in --output) output="$2"; shift 2;; http*) url="$1"; shift;; *) shift;; esac
done
case "$url" in */SHA256SUMS) cp "$QA_MANIFEST" "$output";; *.tar.gz) cp "$QA_ARCHIVE" "$output";; *) exit 1;; esac
`,
	}
	for name, body := range shims {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nset -eu\n"+body), 0700); err != nil {
			t.Fatal(err)
		}
	}
	received := filepath.Join(dir, "received-key")
	argsPath := filepath.Join(dir, "configure-args")
	curlLog := filepath.Join(dir, "curl-log")
	installer := filepath.Join("..", "..", "deploy", "agent", "install.sh")
	environment := append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"), "QA_HASH="+digest, "QA_ARCHIVE="+archivePath, "QA_MANIFEST="+manifest, "QA_RECEIVED_KEY="+received, "QA_CONFIG_ARGS="+argsPath, "QA_CURL_LOG="+curlLog)
	command := exec.Command("sh", installer, "--release-url", "https://private.example/base/downloads/agent", "--endpoint", "https://private.example/base", "--group-id", "private", "--key-stdin")
	command.Env = environment
	command.Stdin = strings.NewReader("lm_installer-test-key\n")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("installer failed: %v %s", err, output)
	}
	key, err := os.ReadFile(received)
	if err != nil || string(key) != "lm_installer-test-key\n" {
		t.Fatal("configuration lost the buffered reporting key", string(key), err)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil || !strings.Contains(string(args), "https://private.example/base\n") || !strings.Contains(string(args), "private\n") {
		t.Fatal("wrong installation route", string(args), err)
	}
	downloads, err := os.ReadFile(curlLog)
	if err != nil || strings.Count(string(downloads), "Authorization: Bearer lm_installer-test-key") != 2 || !strings.Contains(string(downloads), "/"+artifact) || !strings.Contains(string(downloads), "/SHA256SUMS") {
		t.Fatal("downloads missing key or artifact", string(downloads), err)
	}
	// Missing download credentials must stop before the first HTTP request.
	if err = os.Remove(curlLog); err != nil {
		t.Fatal(err)
	}
	command = exec.Command("sh", installer, "--release-url", "https://private.example/base/downloads/agent", "--endpoint", "https://private.example/base", "--key-stdin")
	command.Env = environment
	command.Stdin = strings.NewReader("")
	if output, err = command.CombinedOutput(); err == nil || !strings.Contains(string(output), "reporting key is required") {
		t.Fatal("missing key accepted", string(output), err)
	}
	if _, err = os.Stat(curlLog); !os.IsNotExist(err) {
		t.Fatal("download attempted without credentials", err)
	}
}
