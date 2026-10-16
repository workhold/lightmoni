# 01：SQL 大盘与图表

## 任务目标与边界

实现 LightMoni 自己的大盘模块：用户通过 SQL 查询监控数据，映射字段、配置图表并保存为多个全局共享的大盘。预置主机和应用大盘使用相同的定义与渲染机制，允许复制和编辑。

前端为 React + TypeScript，统计图统一使用 `@antv/g2`，后端为主服务内的 Go 模块。使用 oil-ui 整理视觉层级和交互设计说明；全局规范见主干维护的 `docs/ui-design.md`，验收汇总见 `docs/acceptance.md`。本文中的接口名称和数据结构是待主干确认的契约需求，不代表当前已有实现。先阅读 `docs/brief.md`，开发时再读取主干发布的公共契约、生成类型和模拟响应。

不增加项目、工作空间、逐表权限或大盘 ACL。所有已登录成员使用同一套数据目录，复用主干的用户、角色、第三方登录和会话能力。多份命名上报 Key、service 限制与告警组由对应模块维护，本任务不另建权限或采集凭证模型。查询只能经过公共查询模块执行，浏览器不连接 ClickHouse。不得复制 Grafana 上游源码、引入 Grafana 运行时，或承诺 Grafana JSON、插件和变量语法的完整兼容。

禁止浏览器原生 `<select>` 和 `window.alert/confirm/prompt`。所有选择、确认、保存、命名与输入流程使用共享 React Select/Combobox/Modal/表单组件；普通受控 HTML input/textarea 可用于这些组件内部，禁止的是调用浏览器 prompt。路由离开确认也使用应用内共享 Modal，不借助原生 confirm。

## 官方参考及 LightMoni 首版范围

参考核对日期：2026-10-10。以下链接用于理解功能，不作为 LightMoni 的 API 规格。

| 功能参考 | 官方资料 | LightMoni 首版交付 |
| --- | --- | --- |
| 大盘包含查询与可视化面板；支持创建、复制和保存 | [Create dashboards](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/create-dashboard/) | 大盘列表、创建、查看、编辑、复制、删除，名称、描述和简单标签 |
| 面板编排、字段展示与可视化配置 | [Panel overview](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/panel-overview/) | 添加、编辑、复制、删除、拖动、调整大小；完整核心图表类别见下表 |
| 面板有多查询及查询选项 | [Query and transform data](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/query-transform-data/) | 多条 SQL，以稳定 `refId` 区分；逐条启用/停用、运行、错误和耗时；预览原始数据 |
| 查询变量、自定义变量及选择控件 | [Add variables](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/add-template-variables/) | 查询型、手动选项型、文本和常量变量，单选、多选、全部及依赖变量；服务和自定义属性均可作为变量 |
| 大盘时间及自动刷新设置 | [Modify dashboard settings](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/modify-dashboard-settings/) | 相对/绝对时间范围、时区展示、手动刷新、自动刷新，保存默认值 |
| 保持上下文的数据跳转 | [Configure data links](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/configure-data-links/) | 从点、序列或时间段跳转日志探索，保留时间、表、service 和可映射的维度 |
| 统一字段和查询结果模型 | [Data frames](https://grafana.com/developers/plugin-tools/key-concepts/data-frames) | 消费 LightMoni 公共 typed columns + rows 二维数组 QueryFrame，明确类型、查询来源、空值与错误；不采用 Grafana 的传输格式 |
| 面板缩放、拖选与序列可见性 | [Time series](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/time-series/) | 拖选更新时间范围、平移/缩放还原、tooltip、图例筛选与明确键盘替代操作 |
| 时间、URL 与键盘操作 | [Use dashboards](https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/) | 保存快捷键、查询快捷键、焦点操作、当前筛选 URL 和共享 Modal 保存流程 |

首版采用内置 ClickHouse 数据源，不建设多数据源插件体系。跨表汇总在 SQL 中完成，例如 `UNION ALL` 或 `JOIN`；支持同一面板多查询并列展示，不增加任意前端 join/计算流水线。核心展示处理包括字段选择、重命名、隐藏与重排、指定 reducer、单位、小数位、按字段配置的颜色与轴、图例、堆叠、阈值和空值处理；配置来源与运行结果必须能在检查器中对照。

### 核心图表类别与 AntV 能力核对

官方 G2 文档已核对统计 marks、组合、tooltip、brush 与 legendFilter 能力；它们只提供图形与事件能力，大盘状态、SQL 重查、键盘操作、保存与错误处理仍由 LightMoni 实现。依赖版本在主干开工时锁定，不能把在线文档的版本当作仓库已安装版本。

| 首版面板 | 输入要求与实现职责 | 官方核对 |
| --- | --- | --- |
| 时间序列：折线、点、时间柱、面积、堆叠面积 | 时间、数值与维度；支持左右轴、单位、线型/填充、共享 tooltip 与空值策略；使用 G2 `line/point/interval/area` 和公共轴适配 | [G2 marks](https://g2.antv.antgroup.com/en/manual/core/mark/overview)、[Chart API](https://g2.antv.antgroup.com/en/manual/api) |
| 横/竖柱状图：普通、分组、堆叠 | 类别与数值；排序、方向、分组/堆叠和图例由面板明确配置 | [Bar chart](https://g2.antv.antgroup.com/en/charts/bar) |
| 饼图/环图 | 类别、非负数值；使用 interval、stack 与 theta 坐标，显示数值和占比，负值/全零需明确提示 | [Pie chart](https://g2.antv.antgroup.com/en/charts/pie) |
| 指标卡/趋势小图 | 显式 last/min/max/sum/mean/count reducer；卡片用共享 React 组件，趋势小图用 G2；禁止暗中对不完整结果计算完整总量 | 公共组件与数据语义属于 LightMoni 自身设计 |
| Gauge/Bar gauge | 数值、显式范围/目标与阈值；Gauge 用 G2 `gauge`，Bar gauge 用 interval组合；不默认假定所有指标在 0–100 之间 | [Gauge mark](https://g2.antv.antgroup.com/en/manual/core/mark/gauge) |
| 直方图 | 区间边界和桶计数；使用 rect表示 `[lower, upper)`。原始数值分桶与已聚合 OTLP Histogram分开处理，禁止对桶计数再次 binX | [Histogram](https://g2.antv.antgroup.com/en/charts/histogram) |
| 时间热力图 | 时间、区间/类别与数值；规则网格用 cell，需连续边界时用 rect；稀疏空桶与0桶区分 | [Heatmap](https://g2.antv.antgroup.com/en/charts/heatmap) |
| 状态时间线 | 服务/目标、起止时间或按时间排序的状态点；转换为带状态色的区间，缺失处留空，不假定无数据为可用 | 使用 G2 rect/range组合；由 LightMoni 实现状态点到区间的规则，不能宣称 G2直接等价 Grafana状态面板 |
| 表格、精简日志列表、说明文本 | typed rows原值、排序/列配置/数据链接；公共 React Table负责表格，日志列表复用任务02，Markdown说明使用安全渲染 | 由共享组件实现，不依赖 G2提供完整数据表 |

交互适配参考 [G2 tooltip](https://g2.antv.antgroup.com/manual/component/tooltip)、[brushXFilter](https://g2.antv.antgroup.com/en/manual/core/interaction/brush-x-filter) 和 [legendFilter](https://g2.antv.antgroup.com/en/manual/core/interaction/legend-filter/)。brush返回的本地图形筛选必须经过公共时间状态转换后重新发 SQL，不能只滤掉旧点就声称完成全局缩放。

日志列表面板复用日志模块的精简列表组件；完整搜索、详情和上下文归任务 02。本任务交付到日志探索的跳转。告警创建入口把 SQL、显式变量值和来源表声明的草稿交给任务 03，后者校验表绑定的告警组与通知目标；告警求值与调度不在本模块实现。

插件市场、面板库、任意表达式/变换流水线、面板重复展开、复杂注释、报告订阅、公开分享、完整版本历史以及 Grafana 格式导入不是首版验收项。

## 页面及完整操作流程

### 1. 大盘列表

- 展示标题、描述、标签、更新时间，支持按标题搜索。
- “新建”进入空白编辑页；“复制”生成独立 ID 和面板 ID，修改副本不能影响原件。
- 删除需明确展示大盘名称；删除大盘仅删除管理定义，不删除监控数据。
- 空列表提供创建入口和已有预置模板；模板中的 SQL 必须对应主干实际表目录，未接入数据时说明缺少哪种数据。

### 2. 大盘查看及编辑

- 顶部放标题、变量控件、时间范围、刷新设置、编辑和保存入口。
- 查看模式禁止误拖动；编辑模式可拖动与缩放面板，使用固定网格布局并保存坐标。
- 新建/编辑面板后先应用到当前编辑草稿，保存大盘才持久化；未保存离开时明确提示。
- 单个面板可放大查看、编辑、复制、删除、检查数据和重新执行查询；查看模式具备清晰的面板菜单和可聚焦入口。
- 查询中的服务不固定为一项：一个大盘和一个面板都可以包含多个 service、多张表的数据。
- 大盘默认配置与查看者当前时间/变量状态分开：临时查看不自动覆盖已保存默认值。
- 页面 URL 可携带时间范围和变量选择，重新打开能还原当前筛选；参数按公共路由规则编码和验证。
- 大盘支持全屏展示模式，退出回到原面板位置；拖拽排序以外提供共享键盘移动/尺寸操作，紧凑屏幕可单列展示而不覆盖保存的桌面坐标。
- 保存、另存副本、重命名和删除使用共享 Modal，表单验证在当前弹层显示，保存失败保留草稿与输入，成功再关闭；所有操作有明确的处理中、失败和完成反馈。

### 3. 面板编辑器

1. 左侧查看自动发现的物理表、数据类型、字段与说明；区分 log、metric、trace 类表，但均可写只读 SQL。
2. 添加一条或多条 SQL，分配稳定 `refId`；允许复制、停用和删除查询。输入通过统一查询客户端提交，不在 UI 拼接变量 SQL 字符串。
3. 执行后预览 QueryFrame、字段类型、样本、返回行数、耗时和截断提示。SQL 错误、超时和映射错误分开展示；提供专门的面板检查器，支持切换原始数据、展示映射后的数据、查询/参数、性能/限制、面板定义，并按公共规则导出原始 CSV/JSON。
4. 选择图表类型及字段映射。折线图选择时间字段、数值字段、序列/维度字段；其他图表选择类别、数值、显示字段或指标卡 reducer。
5. 配置标题、单位、精度、图例、颜色、阈值、堆叠、左右轴、字段覆盖和空值策略，预览后应用回大盘；改变图表类型不得丢失原 SQL，字段不适配时保留配置并提示补映射。

多查询的默认行为是合并展示独立序列，图例含查询和维度身份；不把不同 `refId` 的结果直接按行号相加或关联。表格默认按查询切换结果，除非用户已在 SQL 中完成组合。同一时间点的重复行需要选择分组/reducer或修改 SQL，禁止静默取最后一条。

### 4. 变量编辑器

- 查询变量通过公共查询执行器查询选项；支持指定 value 和 label 字段，预览、去重、排序及选项数上限。
- 手动变量使用结构化选项配置；多选以数组参数绑定，不采用逗号拼接 SQL。
- 文本变量采用受控共享表单与类型化参数，常量变量仅编辑时可修改；任何变量都不能注入 HTML或任意SQL片段。
- 变量明确命名、类型、默认值、单选/多选和刷新时机（打开大盘/时间变化）。
- 核心变量支持上下游联动，如选择 service后更新 host选项；公共变量执行计划必须验证依赖环、拓扑顺序和取消失效请求。UI不能各自实现一套依赖推断；下游旧值失效时明确提示/重选，不能静默查询错误服务。
- “全部”必须有统一语义：建议使用显式 all 标志和条件宏，不把字符串 `All` 当作 service，也不能把空选项误认为全部数据。
- 值含引号、中文、逗号等仍应安全绑定；不得将变量值解释为任意表名或 SQL 片段。

### 5. 时间与刷新

- 支持常用相对范围和用户选择的绝对范围；同一次刷新解析一次“现在”，所有面板/变量共享同一个 `[from, to)`。
- 数据时间按公共契约传递，展示时才转换到所选时区，跨表查询不受浏览器时区影响。
- 图表聚合间隔根据跨度、面板宽度和最小间隔计算，并交给公共查询宏处理；不得悄悄用抽样点计算精确指标卡总量。
- 刷新时保留旧数据并显示加载状态；遇到失败明确标记旧数据过期。前一次请求尚未完成时不堆积无限新请求。
- 离开页面停止定时器并取消请求；页面隐藏时暂停自动刷新，恢复时最多触发一次补刷新。
- 更改时间或变量时取消/忽略旧请求，旧响应不得覆盖新筛选结果。
- 时间序列拖选缩放更新大盘全局时间并重新查询全部面板；提供缩小、还原、上一段/下一段及轴平移，操作后 URL与时间控件同步。按起止边界验证，不能只测试图形被放大。
- tooltip支持单点与同时间多序列、完整维度与单位；图例支持显示/隐藏、只看一条、全部还原及搜索较多序列。图例临时隐藏仅影响显示，检查器保留完整查询结果，不能修改已执行 SQL或告警条件。

## oil-ui 视觉与交互设计说明

当前交付是设计说明与开发任务，未渲染产品UI、未实际视觉评审。使用 [oil-ui](https://ui.oiloil.org/) 的品类、首屏任务、视觉层级和三处反馈方法；共享 token、控件与验收阈值由 `docs/ui-design.md` 固定，不在模块内另建风格体系。

- **品类与首屏任务**：这是每天使用的监控工作台。查看页的主角是异常趋势和指标；编辑页的主动作是“写查询 → 核对数据 → 映射图表 → 保存”。顶部筛选持续可见，图表画布占主要空间，不加营销式大标题和装饰。
- **版式决定**：查看页为紧凑工具栏+可调整网格；编辑页为上部可视化/数据预览，下部SQL与查询列表，侧栏负责字段和展示选项。面板检查器使用共享Drawer/Modal，在原上下文中对照，不跳到丢失草稿的新页。
- **信息层级**：标题、当前筛选、查询状态、数值与单位优先；辅助字段退到侧栏或按需展开。错误、旧数据、结果截断除了颜色必须有文字/图标，图例颜色在刷新和放大前后稳定。
- **控件一致性**：变量、表/字段、图表类别、单位、刷新周期全部用共享React Select/Combobox；长列表可搜索，已选多值可移除，字段类型在选项中可辨。保存与删除都使用共享Modal，键盘焦点被约束且关闭后归还触发按钮。
- **反馈与三处动效**：执行/保存按钮立即进入busy状态并在成功后给明确结果；进入编辑/检查器有短促状态过渡；首次进入画布只做一次轻量内容出场。频繁自动刷新不播放整图入场或数字滚动，减少动画偏好下直接到位，证据由实现阶段的录屏验证。
- **键盘与阅读**：Tab可遍历关键控件，方向键/Enter控制Combobox，Esc关闭弹层，Ctrl/Cmd+Enter执行SQL，Ctrl/Cmd+S走同一保存流程。SQL输入时不得劫持普通字母；提供快捷键帮助。长service/表名可查看全名，100%与200%缩放、窄屏布局不能遮挡时间、错误和保存按钮。
- **桌面密度与窄屏策略**：桌面保留对比与字段配置效率，主干固定实际验收视口；窄屏将侧栏与SQL配置收进共享Drawer，减少并排区域，保留查询、时间与保存操作，不靠9–12px字体塞进全部控件。

## Grafana 核心交互对标矩阵

用户要求“核心功能都要有，交互不能比Grafana差”。这里将其落为可执行操作与可观察结果；每项需要浏览器实测证据，不能以图表渲染成功替代。参考官方核心能力，LightMoni自行实现；本矩阵不是完整Grafana格式/所有插件的兼容承诺。记录实际测量的鼠标操作、键盘完成路径和残留差距，不能仅写“体验一致”。

| 编号/核心操作 | 浏览器可执行步骤 | 必须观察的结果/失败验证 |
| --- | --- | --- |
| B01 多大盘与目录 | 新建两张大盘，搜索、打开、重命名、切换 | 独立ID与定义； URL对应选中大盘；空列表可开始新建 |
| B02 多SQL查询 | 添加A/B，复制B为C，编辑、停用与删除C，运行全部 | 按refId独立结果/错误；停用项不发请求；跨服务跨表SQL可以执行 |
| B03 查询输入与提示 | 使用目录补字段/表名，粘贴SQL，以快捷键运行 | 标注类型、明确宏帮助，错误关联当前查询；复制和输入不被页面快捷键截获 |
| B04 图表与字段配置 | 同一查询在时间序列、表格、柱图间切换，设置单位/阈值/轴/颜色 | 原SQL不丢；字段映射明确；所有核心类别按真实数据验证，非法映射有可修正提示 |
| B05 检查原始数据 | 从面板菜单打开检查器，切refId/原始数据/显示映射/统计，导出CSV/JSON | 原值、字段类型、参数、耗时、行数和截断可见；不暴露数据库凭证；导出与原值一致 |
| B06 变量单/多选与全部 | 搜索service、切单选/多选/全部、键盘选择/移除标签 | typed绑定正确；引号/中文/逗号值不误拆；选项多时可检索；空值区别于全部 |
| B07 变量联动 | 选择service更新host选项，快速切换，配置循环依赖 | 下游选项来自最新选择；失效值明确处理；循环依赖不能保存/运行 |
| B08 时间控制 | 相对/绝对范围切换、改时区、上一段/下一段、复制筛选URL | `[from,to)`一致；时间控件/所有面板共享一次解析结果；显示时区不改变同一绝对区间 |
| B09 手动/自动刷新 | 开启刷新、执行慢查询、手动刷新、隐藏/恢复窗口 | 有可见更新状态，旧请求取消或失效；不叠加轮询；保留旧数据且能识别过期结果 |
| B10 面板布局 | 添加/复制/拖动/缩放/删除；用键盘替代移动；退出编辑 | 网格不重叠且布局稳定；查看模式无误拖；保存/回读坐标一致 |
| B11 保存与复制 | 通过共享Modal保存新名称、另存副本；模拟失败后重试 | 失败保留输入与所有草稿；成功回读SQLite定义；副本ID独立；重复提交不生成多份 |
| B12 URL/历史/全屏 | 带变量时间打开链接，浏览器前进/后退，面板放大/退出 | 还原时间/变量/面板；退出回原位置；临时查看不会自动覆盖保存默认值 |
| B13 拖选/缩放/平移 | 时间图拖选异常段、缩小、还原、轴平移 | 顶部范围、URL和SQL请求时间同步，全部面板重新查询；返回更细聚合而非仅滤旧点 |
| B14 Tooltip与图例 | 悬停同时间多序列，隐藏一条、只看一条、搜索图例、还原 | 单位/维度/真实值正确，无裁切；颜色稳定；只变显示，原数据/SQL未被修改 |
| B15 键盘与共享控件 | Tab/方向键/Enter选择，Esc退出Modal，快捷键查询/保存，200%缩放 | 焦点可见、陷阱/归还正确，无原生select/alert/confirm/prompt；控件和错误可读 |
| B16 失败及重试 | 停ClickHouse、断浏览器网络、发送非法SQL、触发超时后恢复重试 | 错误可定位、输入与筛选保留；旧数据标记清晰；部分失败不会假装整面板成功 |
| B17 日志/告警联动 | 异常点跳日志，返回；从跨表查询创建告警草稿 | 日志收到表/service/时间/维度；告警收到完整来源表和显式变量，不带临时图例过滤 |
| B18 数据语义与资源限制 | 选择含null/0/大整数/直方图/截断结果的查询 | 不误补零/溢出/重分桶；Gauge范围显式；总量缺数据时不能无提示显示确定值 |

“不比Grafana差”的判定由这份核心清单、真实浏览器任务完成情况及 `docs/acceptance.md` 的交互检查共同决定；未通过的项保持未完成，不用文档承诺替代实际证据。

## 持久化模型要求

大盘定义由 SQLite 保存。建议包括：稳定 ID、标题、描述、标签、默认时间与刷新设置、变量定义、面板数组及更新版本号。

每个面板保存：稳定 ID、布局、标题、图表类型、查询数组（`refId`、SQL、启用状态）、字段映射、展示选项、字段覆盖和结构化日志跳转配置。保存的是原始参数化 SQL，不是某次执行后展开的 SQL；不保存结果数据、上报 Key 或 ClickHouse 凭证。临时图例过滤、检查器分页和查询加载状态不写成查询条件。

同一浏览器或两位成员并发保存时，使用简单 revision/ETag 乐观锁，冲突返回可操作错误；不自动覆盖较新定义，不建设协同编辑系统。主干负责冻结文档版本字段与未知结构校验规则，本模块不自行增加旧格式迁移或 Grafana 兼容层。

## 所需 API 与公共契约

下面为拟定路由职责，最终路径、JSON 结构和错误码由任务 06 在 `api/` 内统一发布。大盘任务可提交契约修改建议，不直接修改公共接口文件。

| 契约职责 | 建议路径或操作 | 提供方 |
| --- | --- | --- |
| 大盘列表、获取、创建、更新、删除 | `/api/v1/dashboards`、`/api/v1/dashboards/{id}` | 本任务 Go 模块 |
| 复制大盘 | 可用创建接口提交独立副本；无需额外复杂接口 | 本任务 |
| 表目录、字段类型、数据类型和属性字段说明 | `/api/v1/catalog/tables`、表字段详情 | 主干 |
| 单/多查询执行及取消、统一限制 | `/api/v1/query`，携带多 `refId`、时间、类型化变量、请求 ID | 主干 |
| 宏与参数能力、限制和默认值 | 公共 schema/能力信息，供编辑器提示 | 主干 |
| 日志跳转状态 | 统一 `LogExploreState` 编码/路由适配器 | 日志任务与主干 |
| 从面板创建告警 | `AlertRuleDraft`；携带 SQL、时间窗口及显式变量值 | 告警任务与主干 |

### QueryFrame 必须满足的要求

公共执行器可返回一个或多个 frame；本模块只做展示映射，不自行推断另一套结果类型。需满足：

1. 统一采用 **typed `columns` + `rows` 二维数组**：columns有稳定字段名、明确逻辑类型及可选单位，rows每一行严格按columns顺序且长度一致；frame关联`refId`。禁止本模块增加另一套列式values协议或把ClickHouse任意JSON直接当成frame。
2. 时间精度、时区与序列排序语义明确；具有空值的数值列和缺失时间点保持原义，图表默认不补零、不跨缺口连线，用户可明确选择。
3. Int64/UInt64/Decimal 不通过 JavaScript Number 无损假设传递；保留文本原值，表格可精确展示。图表转换若不安全应提示、要求 SQL 转换或明确展示近似值，禁止静默把大计数改错。
4. 数值字段、序列/维度字段、单位及显示名称可由字段元数据或用户映射提供。多维度使用稳定维度键组合，不因数组/对象顺序不同产生不同序列。
5. 每个查询有独立 success/empty/error/cancelled 状态、耗时、行数、资源上限/截断提示；HTTP 成功不等于所有查询成功。一条查询失败仍可展示其他结果，但面板必须标明部分失败。
6. 无数据区别于数值 0；截断区别于完整结果。指标卡总量等可能受截断影响的展示不能给出无提示的“完整总数”。
7. 响应含请求身份，客户端可以屏蔽过期结果。可取消查询和并发上限由公共模块落实，不能仅靠前端按钮限制。

### 查询与宏要求

- 只读 SQL、安全执行、数据库权限、外部表函数限制、超时/行数/并发限制由主干统一实现。本任务不能仅用正则“检查 SELECT”代替公共限制。
- 冻结时间过滤、时间桶、聚合间隔以及标量/数组变量的唯一语法；UI 提示和模板均从公共定义取得。参考 Grafana 不等于必须沿用其宏名字。
- SQL 可以访问实例内允许查询的监控表，不引入按服务权限。不自动添加 service 过滤：是否过滤由用户 SQL 和显式变量控制。
- 时间宏要基于原始采集时间。直方图分位数、Counter 增量等模板从主干指标 schema 生成，不能对 histogram 的单个桶或累积 Counter 直接做普通平均。

## 代码归属与依赖

本任务可修改：

- `web/src/features/dashboards/**`：页面、面板编辑器、模块内图表适配、字段映射、类型化状态及测试。
- `internal/dashboards/**`：定义校验、持久化、CRUD handlers及测试。
- `examples/dashboards/**`：基于真实公共 schema 的预置定义和示例 SQL；目录开工前与主干确认。

公共类型、API 客户端、时间控件、Select/Combobox/Modal/Drawer/Table、SQL 编辑器封装、`@antv/g2`基础适配、应用路由、主题和 SQLite 初始化归主干。若这些需要本任务先实现，先协调归属，然后只由一个任务维护公共文件。

统计图确定使用 `@antv/g2`，SQL编辑器由主干统一选择与封装，不由模块各自引入Monaco/其他编辑器。主干锁定依赖版本、懒加载和主题，图表初始化/销毁、容器resize及共享数据映射基础只实现一份。本模块消费统计图适配，自己实现面板状态和大盘交互；表格使用公共Table，不从图表库模拟数据表。同类控件全部复用共享React组件。本任务仅写oil-ui设计说明，不承担风格卡片或mockup，当前没有渲染/视觉通过声明。

依赖：主干应用壳、认证（含第三方登录统一身份）、typed columns+rows QueryFrame、目录、SQL/参数宏、SQLite repository入口、`docs/ui-design.md`和`docs/acceptance.md`；日志跳转与告警草稿可先使用共享模拟适配器，任务 02/03 完成后真实联调。SDK/Agent提供的service和表目录自动发现用于预置模板验证，不要求提前在大盘创建项目或服务。

## 分步交付

| 阶段 | 交付与验收条件 |
| --- | --- |
| D0 契约与UI对齐 | 冻结本任务依赖的契约、共享React控件和G2适配；真实字段示例、空值/错误/大整数/多query fixture齐全；认可B01–B18矩阵，不先写私有查询协议或原生弹层 |
| D1 管理与草稿 | 列表/创建/复制/删除、Go CRUD 与 SQLite保存、共享Modal、编辑草稿和冲突处理；保存失败输入保留，重启后定义可获取 |
| D2 SQL 与可视化 | SQL编辑/目录/多查询、面板检查器、全部核心类别及字段覆盖；先fixture后连Docker真实ClickHouse；不能只交五种静态图 |
| D3 变量与时间 | 单/多选/联动变量、全局时间、刷新、URL状态、取消、竞态；真实跨表/跨service查询、缩放拖选、tooltip与图例过滤 |
| D4 产品与交互集成 | 预置大盘、日志跳转、告警草稿入口（随任务03）、错误与资源提示；本机Agent和Go/Node SDK demo实际上报；B01–B18浏览器/键盘/重启验收留证据 |

## 真实验收清单

验收在隔离测试目录使用真实SQLite，通过Docker启动真实ClickHouse，并运行本机Agent采集机器指标、Go SDK demo与Node.js TypeScript SDK demo产生业务计数/日志/Histogram。测试数据至少包括两个service、两个日志表、两个指标表，固定采集时间、空值、0值、多个维度以及超出JavaScript安全整数的数值。隔离fixture验证边界，然后真实链路验证主要流程；不以mock成功、静态截图、仅直接INSERT测试数据或写文档替代SDK→Agent→主服务→ClickHouse→浏览器完整运行。

每个B01–B18项记录测试环境、版本、操作、预期/实际、通过状态及截图/录屏路径到主干要求的证据目录；SQL结果对照ClickHouse查询，保存对照API重新读取，缩放/刷新对照实际请求时间与服务端执行。主干维护统一验证脚本，代表性异步/保存/恢复链路按全局验收要求重复通过；本任务不能编造尚未运行的性能数值或视觉评分。

- **多大盘**：创建“机器总览”和“业务总览”，分别保存；刷新页面及重启主服务后仍存在。复制后只修改副本，原件不变；删除定义不删除对应数据。
- **面板布局与持久化**：拖动、缩放、改标题/单位/映射后保存；重新打开与保存配置一致；未保存离开可保留/放弃草稿。
- **多查询**：一个折线面板含 A/B 两条真实 SQL，分别查询不同表/服务，图例身份正确；停用 B 后不发 B 查询。A 错误不遮蔽 B 的结果，面板标记部分失败。
- **跨表 SQL**：通过 `UNION ALL` 汇总两张结构一致的指标表，结果与 ClickHouse 原始 SQL 一致；合法的跨表查询不被前端限为单表。
- **变量**：由真实 SQL生成 service选项；单选、多选和全部获得预期计数。含引号、中文或逗号的维度值不产生 SQL注入或错误拆分；空选项和变量查询失败可见。
- **时间与刷新**：固定 `[from,to)` 包含左边界、排除右边界；改变时区不改变同一时间段的结果。断网补传的旧数据出现在其原始时间。相对窗口每轮整体前移，不由每个面板各取“现在”。
- **请求竞态**：先发慢查询再快速变更变量，旧响应不能覆盖新结果；离开页面无持续轮询。慢查询超过自动刷新周期时不产生持续累积请求。
- **字段与图表正确性**：核心类别表中的全部图表用真实结果验证，时间序列含共享tooltip/图例与面积/堆叠；0、null、缺失点不混淆；大整数表格精确展示，不能静默溢出；Histogram桶不再次分桶、热力稀疏桶正确、Gauge范围显式、状态缺失留空；映射到非数值字段时给出操作建议。
- **保存冲突及运行错误**：两个会话编辑同一大盘触发明确冲突；非法 SQL、查询超时、未知表、ClickHouse不可用和结果截断均可见；只读限制由后端测试证明。
- **日志联动**：从异常点或拖选时间段跳到任务 02，目标表/service/时间/维度与点击上下文一致，浏览器前进后退仍能还原。目标缺少所需字段时提示，不伪造过滤条件。
- **预置模板**：安装 Agent产生真实主机指标后，复制/打开主机模板可出图；未接入某类数据的面板展示接入提示，不报告为“机器正常”。
- **SDK维度聚合与网络恢复**：Go/Node demo按固定次数发送counter并指定service/table/多维度，查询总数与程序预期一致；Agent断网后补传，原始时间恢复、重试不重复计数、图表缩放至旧窗口仍能查到数据。
- **共享控件静态与浏览器检查**：代码扫描确认模块无`<select>`和`window.alert/confirm/prompt`调用，再实际测试键盘选项、共享Modal保存/删除、焦点回归、错误输入保留和窄屏/200%缩放。静态扫描通过不能替代交互通过。

## 需要主干先冻结的五项契约

1. **公共查询请求/响应**：typed columns+rows QueryFrame、Int64/Decimal与时间编码、逐 `refId` 状态、资源/截断信息、取消与错误码及原始数据导出。
2. **SQL模板语义**：时间范围边界、桶间隔、时间宏、类型化变量/数组绑定和“全部”语义，变量依赖计划及缩放重查事件。
3. **数据目录与指标语义**：物理表前缀/后缀、系统字段、属性访问、单位、Counter时间语义和Histogram查询模板；无需由大盘模块复制存储路由。
4. **大盘持久化协议**：Dashboard/Panel/Variable最小schema、保存版本和冲突行为、SQLite接入及模块CRUD注册方式。
5. **共享前端集成**：Query客户端、路由/URL状态、日志跳转/告警草稿（含来源表）结构、公共时间/SQL/G2/Select/Combobox/Modal/Table组件及单一维护者；`ui-design.md`和`acceptance.md`统一证据标准。

最大风险是先做出图表再补数据语义，导致计数重复、时间错位、空值补零或查询结果截断后仍显示“总量”。D0应先用fixture和真实SQL确定这些边界，再实现渲染与交互。

## 实施记录（2026-10-10）

已落地 `internal/dashboards` 和 `web/src/features/dashboards`。后端 `New(shared.Dependencies)` / `Register(*http.ServeMux)` 已可由主干注册；SQLite CRUD、独立复制、revision冲突及定义校验可运行。API为：

- `GET/POST /api/v1/dashboards`；`GET/PUT /api/v1/dashboards/{id}`。
- `DELETE /api/v1/dashboards/{id}?revision=N`；`POST /api/v1/dashboards/{id}/copy`。
- `POST /api/v1/dashboards/alert-draft`：明确选择单条查询，输入 `{query,range}`，通过公共AST/目录返回 `{sql,params,range,source_table_ids}`；告警模块保存时继续复验。

前端默认导出 `DashboardPage`，主干需注册 `/dashboards` 和 `/dashboards/:id` 两条路由。页面包含目录模板快速创建、面板编辑/查询、变量与依赖、布局、时间刷新、错误重试、检查器和数据导出、日志及告警联动。图表支持line/timeseries/area/bar/pie/stat/table/gauge/heatmap/histogram/timeline；日期列使用time scale，本地时间刻度，percent值按百分数展示。高精度原值保留；图表近似需明确开启。没有使用原生选择框或浏览器对话框。

未保存大盘配置可以恢复本浏览器会话草稿，仍保持原revision以检测服务端冲突。应用内锚点离开使用共享Modal；时间/变量变更产生可回退的URL，文本变量采用replace避免每次输入生成历史项。

已执行并通过：

- `go test ./internal/dashboards`：真实独立SQLite数据库，复制/更新/删除版本冲突、重新打开数据库回读、无损参数、变量依赖与时间校验，以及委托公共SQL AST生成告警来源。
- `node --test src/features/dashboards/model.test.mjs`：11项模型测试，覆盖统一时间、类型化多选、引号/逗号保留、变量依赖环、注释/字符串排除、精度策略、阈值边界、null/大整数映射、补零/间隙/连接、稳定颜色和时间柱正负分离堆叠。
- `npm run typecheck`：全库React/TypeScript检查通过。

本模块已加入可见的阈值、精确/范围/null值映射、gap/connect/zero空值策略、每条序列颜色和观测点开关。线图用G2 lineY阈值标注；Gauge、指标和表格应用阈值/映射颜色；时间柱与时间热力图使用显式区间rect，避免time scale调用getBandWidth。日期域使用当前查询时间范围，不将epoch数字作为类别轴。采样节奏比时间桶粗时，gap策略参考稳定观测节奏识别较长断点；zero策略明确按桶补零，原始结果不改。

`node src/features/dashboards/verify-ui.mjs` 使用5173/18880隔离开发环境、Docker ClickHouse、本机Agent CPU及受控SQL fixture，走实际UI配置、执行、保存和重载。最终代码连续3次通过（2026-10-10），各轮无pageerror、无原生select/dialog和无横向溢出。核心line/area/time-bar/pie/stat/table/gauge/time-heatmap均实际渲染；CPU来自Agent，其余受控SQL用于稳定验证值映射和绘图边界，不替代主干的Go/Node SDK完整接入验收。

截图已查看，现归档在本机 `artifacts/screenshots/examples/dashboards/evidence/`：`thresholds-and-series.png`、`value-mapping-and-null.png`、`core-chart-gallery.png`；最后一轮记录见`report.json`。保留最终QA副本`da1cf2cb-96af-4cab-a42d-61523c806ab0`以便复查，其余本任务创建的5份QA副本已清理，原CPU验收大盘保持不变。共享AI上下文已显式发布dashboard_id、绝对range及单值service，不从SQL反推table。

完整B01–B18的故障链路和跨模块联合验收仍由主干逐项记录；任意字段覆盖/变换流水线与逐序列多于两轴的配置暂不在当前实现中，不能将已通过的绘图检查描述成完整Grafana格式与所有插件兼容。


### 双 Y 轴补充验收

line/timeseries、area、bar 支持按查询 refId 显式选择右轴。`options.right_axis_refs: string[]` 决定右轴查询，其余启用查询放左轴；至少保留一条左轴查询。`unit` 和 `right_unit` 独立，`left_scale/right_scale` 支持 `linear/log`，`left_min/left_max/right_min/right_max` 可分别设置上下界，省略时独立按数据推断。阈值线及阈值柱着色使用左轴原始单位；右轴保留序列颜色，避免将不同单位误用同一阈值。右轴查询改名会同步引用，删除会移除引用，替换为单查询模板会清空右轴选择。

比例尺实现核对了 [G2 5.4.8 官方双轴柱图](https://g2.antv.vision/en/examples/general/dual/dual-axis-stacked-group-bar/) 与已安装 `src/runtime/mark.ts` 的 scale key 分组机制。左右使用不同 key，同侧曲线、观测点和阈值标注共享自己的 key；点标记保留同侧坐标轴配置，避免 false 覆盖使整组轴消失。共享 x 时间域和颜色域，tooltip 每个值使用所属轴单位，Inspector/CSV/JSON 保留原始帧。

时间与类别柱使用显式 rect 区间；非堆叠保留全局序列槽位，堆叠按轴分开，避免 CPU 比例与内存字节相加。对数轴拒绝零/负数，提示调整 SQL 或补零策略；对数面积使用正基线并拒绝堆叠；双轴面积使用透明填充保留两侧序列可读性。浏览器共享 Select 配置与原有保存 Modal，无原生选择或对话框。

`node src/features/dashboards/verify-dual-axis.mjs` 使用 Docker ClickHouse 上本机 Agent 的两条真实 SQL：CPU 利用率约 0.089–0.716，内存约 96.9–104.7GB。已实测 UI 选择 B 右轴、bytes 单位、序列颜色覆盖、保存回读/重载、两侧刻度位置与单位、图例筛选/恢复及 shared tooltip；随后设置左轴线性 0–1、右轴对数 1e8–1e12，并在 line/area/time-bar 上真实执行和渲染。证据为 `dual-axis-line.png`、`dual-axis-tooltip.png`、`dual-axis-gallery.png` 与 `dual-axis-report.json`。这组数据来自实际 Agent；未用 mock 或伪造 SDK 数据替代。

窄屏复查增加统一字节格式：轴、tooltip、指标卡通过相同 formatter 显示 B/KiB/MiB/GiB/TiB；原值继续保留在 typed frames / Inspector。小于500px的图表使用3个短时间刻度（HH:mm）、3个Y轴目标刻度、较小字体和更少左右留白，轴标题移至面板下方的明确左右单位说明。390px浏览器验收要求绘图区至少120px、短时间标签和无水平溢出；截图见 `dual-axis-narrow.png`。G2初次tooltip测量尺寸的问题通过显式bounding及show后边界校正处理，右边缘的两侧数值和单位均可阅读。

最终完整双轴/窄屏脚本已通过（2026-10-10），最后 QA 大盘为 `ce21977d-37f7-4857-9877-bc0d650d4540`；保留先前主干审阅中的 `6e47e481-1549-4938-aab9-185617fc40ba`，其他本轮自建临时副本均已清理。原 CPU 验收大盘未改动。最终 `npm run typecheck` 与11项模型测试通过，生产打包由主干统一执行。
