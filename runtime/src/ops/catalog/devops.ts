import {
  compose,
  define,
  depends,
  externalURL,
  fixedPorts,
  health,
  password,
  pg,
  port,
  secret,
  volume,
} from "./types.js";
export const devops = [
  define(
    {
      id: "gitea",
      name: "Gitea",
      description: "轻量 Git 代码托管，包含 Web 与 SSH 入口。",
      description_en: "Lightweight Git hosting with web and SSH access.",
      category: "devops",
      version: "28.2.0",
      homepage: "https://docs.gitea.com/installation/install-with-docker",
      deployment_modes: ["manual"],
      notes:
        "首次访问完成安装向导并创建管理员。外部 URL 可使用已配置的 HTTPS 网关地址；SSH 端口须固定。",
      notes_en:
        "Complete the installation wizard and create an administrator on first visit. The public URL can use an existing HTTPS gateway. Use a fixed SSH port.",
      parameters: [externalURL],
    },
    (p, c) =>
      compose(
        {
          gitea: {
            image: "gitea/gitea:28.2.0",
            environment: {
              GITEA__database__DB_TYPE: "sqlite3",
              GITEA__server__ROOT_URL: p.external_url,
              GITEA__server__DOMAIN: new URL(p.external_url).hostname,
              GITEA__server__SSH_DOMAIN: new URL(p.external_url).hostname,
              GITEA__server__SSH_PORT: String(c.host_ports.ssh ?? 22),
            },
            volumes: [volume("gitea-data", "/data")],
            healthcheck: health(
              [
                "CMD-SHELL",
                "wget -q -O /dev/null http://127.0.0.1:3000/api/healthz",
              ],
              "30s",
            ),
          },
        },
        [port("http", 3000, "gitea", "http"), port("ssh", 22, "gitea")],
      ),
    (_p, c) => fixedPorts(c, ["http", "ssh"]),
  ),
  define(
    {
      id: "jenkins",
      name: "Jenkins",
      description: "持续集成服务，首次启动创建指定管理员。",
      description_en:
        "Continuous integration server with a configured initial administrator.",
      category: "devops",
      version: "2.580.2-jdk21",
      homepage: "https://www.jenkins.io/doc/book/installing/docker/",
      resources: { cpu: 2, memory_mb: 2048 },
      notes:
        "管理员用户名 admin。构建请连接独立 Jenkins Agent；不挂载宿主 Docker socket。",
      notes_en:
        "The administrator username is admin. Connect dedicated Jenkins build agents.",
      parameters: [password("管理员密码", "Administrator password")],
    },
    (p) => {
      const s = compose(
        {
          jenkins: {
            image: "jenkins/jenkins:2.580.2-jdk21",
            environment: {
              JAVA_OPTS:
                "-Djenkins.install.runSetupWizard=false -Xms256m -Xmx1024m",
              JENKINS_ADMIN_PASSWORD: p.password,
            },
            volumes: [volume("jenkins-data", "/var/jenkins_home")],
            healthcheck: health(
              [
                "CMD-SHELL",
                "curl --fail --silent http://127.0.0.1:8080/login >/dev/null",
              ],
              "60s",
            ),
          },
        },
        [
          port("http", 8080, "jenkins", "http"),
          port("agent", 50000, "jenkins"),
        ],
      );
      s.compose.services.jenkins.environment.JENKINS_BOOTSTRAP_GROOVY = `import jenkins.model.Jenkins
import hudson.security.HudsonPrivateSecurityRealm
import hudson.security.FullControlOnceLoggedInAuthorizationStrategy
def j = Jenkins.get()
def marker = new File(j.getRootDir(), '.lightmoni-bootstrap')
if (!marker.exists()) {
  def realm = new HudsonPrivateSecurityRealm(false)
  realm.createAccount('admin', System.getenv('JENKINS_ADMIN_PASSWORD'))
  j.setSecurityRealm(realm)
  def strategy = new FullControlOnceLoggedInAuthorizationStrategy()
  strategy.setAllowAnonymousRead(false)
  j.setAuthorizationStrategy(strategy)
  j.save()
  marker.text = 'initialized'
}
`;
      s.compose.services.jenkins.entrypoint = [
        "/bin/sh",
        "-ec",
        `mkdir -p /var/jenkins_home/init.groovy.d; printf '%s' "$JENKINS_BOOTSTRAP_GROOVY" > /var/jenkins_home/init.groovy.d/01-lightmoni.groovy; exec /usr/bin/tini -- /usr/local/bin/jenkins.sh`,
      ];
      s.compose.services.jenkins.command = [];
      return s;
    },
  ),
  define(
    {
      id: "gitlab",
      name: "GitLab CE",
      description: "代码托管、评审与 CI/CD 平台。",
      description_en: "Code hosting, review and CI/CD platform.",
      category: "devops",
      version: "19.4.5-ce.0",
      homepage: "https://docs.gitlab.com/install/docker/installation/",
      resources: { cpu: 4, memory_mb: 8192 },
      deployment_modes: ["manual"],
      notes:
        "首次启动可能需数分钟。root 为初始管理员；本配方提供 HTTP，HTTPS 由现有网关终止。Runner 需另外接入。",
      notes_en:
        "Initial startup can take several minutes. The initial user is root. This recipe serves HTTP; terminate HTTPS at an existing gateway. Register runners separately.",
      parameters: [
        externalURL,
        password("root 初始密码", "Initial root password"),
      ],
    },
    (p, c) =>
      compose(
        {
          gitlab: {
            image: "gitlab/gitlab-ce:19.4.5-ce.0",
            shm_size: "256m",
            environment: {
              GITLAB_ROOT_PASSWORD: p.password,
              GITLAB_OMNIBUS_CONFIG: `external_url ${JSON.stringify(p.external_url)}; nginx['listen_port'] = 80; nginx['listen_https'] = false; letsencrypt['enable'] = false; gitlab_rails['gitlab_shell_ssh_port'] = ${c.host_ports.ssh ?? 22};`,
            },
            volumes: [
              volume("gitlab-config", "/etc/gitlab"),
              volume("gitlab-logs", "/var/log/gitlab"),
              volume("gitlab-data", "/var/opt/gitlab"),
            ],
          },
        },
        [port("http", 80, "gitlab", "http"), port("ssh", 22, "gitlab")],
      ),
    (_p, c) => fixedPorts(c, ["http", "ssh"]),
  ),
  define(
    {
      id: "nexus",
      name: "Nexus Repository",
      description: "Maven、npm 等软件制品仓库。",
      description_en: "Artifact repository for Maven, npm and other packages.",
      category: "devops",
      version: "3.96.5",
      homepage: "https://github.com/sonatype/docker-nexus3",
      resources: { cpu: 2, memory_mb: 4096 },
      notes:
        "首次管理员密码位于容器 /nexus-data/admin.password，请通过受控终端读取并登录修改。Docker 仓库连接器需在应用内另外配置。",
      notes_en:
        "Read the initial administrator password from /nexus-data/admin.password through a controlled terminal, then change it after login. Configure Docker repository connectors inside Nexus.",
      parameters: [],
    },
    () =>
      compose(
        {
          nexus: {
            image: "sonatype/nexus3:3.96.5",
            environment: {
              INSTALL4J_ADD_VM_PARAMS:
                "-Xms512m -Xmx2048m -XX:MaxDirectMemorySize=1024m -Djava.util.prefs.userRoot=/nexus-data/javaprefs",
            },
            volumes: [volume("nexus-data", "/nexus-data")],
            healthcheck: health(
              [
                "CMD-SHELL",
                "curl --fail --silent http://127.0.0.1:8081/ >/dev/null",
              ],
              "120s",
            ),
          },
        },
        [port("http", 8081, "nexus", "http")],
      ),
  ),
  define(
    {
      id: "sonarqube",
      name: "SonarQube Community Build",
      description: "代码质量与静态分析，包含独立 PostgreSQL。",
      description_en:
        "Code quality and static analysis with a dedicated PostgreSQL database.",
      category: "devops",
      version: "26.10.0.133078-community",
      homepage:
        "https://docs.sonarsource.com/sonarqube-community-build/server-installation/from-docker-image/starting-sonarqube-container",
      resources: { cpu: 2, memory_mb: 4096 },
      notes:
        "首次用上游初始账号登录并立即设置新密码。主机需满足 Elasticsearch 的 vm.max_map_count / 文件句柄要求。",
      notes_en:
        "Sign in with the upstream initial account and immediately set a new password. Meet Elasticsearch host requirements for vm.max_map_count and file descriptors.",
      parameters: [],
    },
    (_p, c) => {
      const dbPassword = secret(c);
      return compose(
        {
          postgres: pg(dbPassword, "sonar", "sonar"),
          sonarqube: {
            image: "sonarqube:26.10.0.133078-community",
            environment: {
              SONAR_JDBC_URL: "jdbc:postgresql://postgres:5432/sonar",
              SONAR_JDBC_USERNAME: "sonar",
              SONAR_JDBC_PASSWORD: dbPassword,
            },
            depends_on: depends("postgres"),
            volumes: [
              volume("sonar-data", "/opt/sonarqube/data"),
              volume("sonar-extensions", "/opt/sonarqube/extensions"),
              volume("sonar-logs", "/opt/sonarqube/logs"),
            ],
            healthcheck: health(
              [
                "CMD-SHELL",
                'curl --fail --silent http://127.0.0.1:9000/api/system/status | grep -q \'"status":"UP"\'',
              ],
              "120s",
            ),
          },
        },
        [port("http", 9000, "sonarqube", "http")],
      );
    },
  ),
];
