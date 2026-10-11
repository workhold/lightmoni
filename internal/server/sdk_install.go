package server

import (
	"io/fs"
	"strings"
)

const sdkVersion = "0.1.0"

type sdkPackage struct {
	ID        string `json:"id"`
	Language  string `json:"language"`
	Runtime   string `json:"runtime"`
	File      string `json:"file"`
	URL       string `json:"url"`
	Available bool   `json:"available"`
}

func sdkPackages(externalURL string) []sdkPackage {
	packages := []sdkPackage{
		{ID: "typescript", Language: "JavaScript / TypeScript / 浏览器", Runtime: "Node.js 20+ / 现代浏览器", File: "lightmoni-sdk-" + sdkVersion + ".tgz"},
		{ID: "go", Language: "Go", Runtime: "Go 1.26+", File: "lightmoni-go-sdk_" + sdkVersion + ".tar.gz"},
		{ID: "python", Language: "Python", Runtime: "Python 3.9+", File: "lightmoni-python-sdk_" + sdkVersion + ".tar.gz"},
		{ID: "java", Language: "Java / Kotlin JVM", Runtime: "JDK 17+", File: "lightmoni-java-sdk_" + sdkVersion + ".tar.gz"},
		{ID: "dotnet", Language: "C# / .NET", Runtime: ".NET 8+", File: "lightmoni-dotnet-sdk_" + sdkVersion + ".tar.gz"},
		{ID: "php", Language: "PHP", Runtime: "64 位 PHP 8.1+", File: "lightmoni-php-sdk_" + sdkVersion + ".tar.gz"},
		{ID: "ruby", Language: "Ruby", Runtime: "Ruby 2.7+", File: "lightmoni-ruby-sdk_" + sdkVersion + ".tar.gz"},
		{ID: "rust", Language: "Rust", Runtime: "Rust 1.85+", File: "lightmoni-rust-sdk_" + sdkVersion + ".tar.gz"},
	}
	base := strings.TrimRight(externalURL, "/")
	for i := range packages {
		packages[i].URL = base + "/downloads/sdk/" + packages[i].File
		_, err := fs.Stat(assets, "agent-dist/"+packages[i].File)
		packages[i].Available = err == nil
	}
	return packages
}

func allowedSDKFile(file string) bool {
	if file == "SDK_SHA256SUMS" {
		return true
	}
	for _, p := range sdkPackages("") {
		if p.File == file {
			return true
		}
	}
	return false
}
