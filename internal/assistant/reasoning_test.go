package assistant

import "testing"

func TestReasoningEffortDefaultsAndValidation(t *testing.T) {
	legacy := normalizedConfig(Config{BaseURL: "https://models.example/v1", Model: "fixture"})
	if legacy.ReasoningEffort != ReasoningProviderDefault {
		t.Fatalf("legacy reasoning effort = %q, want %q", legacy.ReasoningEffort, ReasoningProviderDefault)
	}

	valid := []string{
		ReasoningProviderDefault,
		ReasoningNone,
		ReasoningMinimal,
		ReasoningLow,
		ReasoningMedium,
		ReasoningHigh,
		ReasoningXHigh,
	}
	for _, effort := range valid {
		t.Run(effort, func(t *testing.T) {
			if err := ValidateConfig(Config{BaseURL: "https://models.example/v1", Model: "fixture", ReasoningEffort: effort}); err != nil {
				t.Fatalf("valid reasoning effort rejected: %v", err)
			}
		})
	}

	if err := ValidateConfig(Config{BaseURL: "https://models.example/v1", Model: "fixture", ReasoningEffort: "unsupported"}); err == nil {
		t.Fatal("unsupported reasoning effort accepted")
	}
}
