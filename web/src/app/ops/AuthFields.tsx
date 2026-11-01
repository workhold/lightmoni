import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, Select } from "../../shared/ui";
import { useI18n } from "../../shared/i18n";
type Path = (string | number)[];
export default function AuthFields({
  name,
  watchPath,
  location = false,
}: {
  name: Path;
  watchPath: Path;
  location?: boolean;
}) {
  const { t } = useI18n(),
    form = Form.useFormInstance(),
    auth = Form.useWatch(watchPath, form);
  return (
    <div className="lm-ops-auth-fields">
      <Form.Item
        name={[...name, "mode"]}
        initialValue={location ? "inherit" : "off"}
        label={
          location
            ? t("路径访问鉴权", "Path authentication")
            : t("网站访问鉴权", "Website authentication")
        }
      >
        <Select
          onChange={(mode) => {
            if (
              mode === "basic" &&
              !form.getFieldValue([...watchPath, "users"])?.length
            )
              form.setFieldValue(watchPath, {
                mode,
                realm: "Restricted",
                users: [{ username: "", password: "" }],
              });
          }}
          options={[
            ...(location
              ? [{ value: "inherit", label: t("继承全站", "Inherit site") }]
              : []),
            { value: "off", label: t("关闭", "Off") },
            {
              value: "basic",
              label: t("账号密码（Basic）", "Username and password (Basic)"),
            },
          ]}
        />
      </Form.Item>
      {auth?.mode === "basic" && (
        <>
          <Alert
            type="info"
            showIcon
            title={t(
              "鉴权需要 HTTPS；不支持与直接返回、CORS、代理缓存或自定义配置组合。",
              "Authentication requires HTTPS and cannot be combined with direct returns, CORS, proxy cache or custom directives.",
            )}
          />
          <Form.Item
            name={[...name, "realm"]}
            label={t("鉴权提示", "Authentication realm")}
            rules={[{ required: true, max: 100 }]}
          >
            <Input />
          </Form.Item>
          <Form.List name={[...name, "users"]}>
            {(fields, { add, remove }) => (
              <>
                <div className="lm-ops-subheading">
                  <strong>{t("登录账号", "Accounts")}</strong>
                  <Button
                    size="small"
                    icon={<PlusOutlined aria-hidden />}
                    onClick={() => add({ username: "", password: "" })}
                  >
                    {t("添加账号", "Add account")}
                  </Button>
                </div>
                {fields.map((f) => (
                  <div className="lm-ops-auth-user" key={f.key}>
                    <Form.Item
                      name={[f.name, "username"]}
                      label={t("账号", "Username")}
                      rules={[
                        {
                          required: true,
                          pattern: /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/,
                        },
                      ]}
                    >
                      <Input autoComplete="off" />
                    </Form.Item>
                    <Form.Item
                      name={[f.name, "password"]}
                      label={t(
                        "密码（同名账号留空保留）",
                        "Password (blank retains same user)",
                      )}
                      rules={[{ min: 8, max: 72 }]}
                    >
                      <Input.Password autoComplete="new-password" />
                    </Form.Item>
                    <Button
                      aria-label={t(
                        "删除鉴权账号",
                        "Remove authentication account",
                      )}
                      danger
                      icon={<DeleteOutlined aria-hidden />}
                      disabled={fields.length === 1}
                      onClick={() => remove(f.name)}
                    />
                  </div>
                ))}
              </>
            )}
          </Form.List>
        </>
      )}
    </div>
  );
}
