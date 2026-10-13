package shared

// NotificationProfile is kept separate from login identity and provider secrets.
type NotificationProfile struct {
	UserID     string `json:"user_id"`
	Email      string `json:"email"`
	Phone      string `json:"phone"`
	FeishuID   string `json:"feishu_id"`
	DingtalkID string `json:"dingtalk_id"`
	WecomID    string `json:"wecom_id"`
	Timezone   string `json:"timezone"`
	Source     string `json:"source"`
	UpdatedAt  string `json:"updated_at"`
}
