# 独立视觉评审与复核

2026-11-01。按oil-ui评审协议由隔离评审执行者只读现有ui-design规范、三轮报告、截图与动效帧；未读实现源码、未修改文件，不打分。

初评确认桌面/空态/弹窗密度、主操作及既有AntD风格一致，窄屏与200%裁切集中于可横滚表格。指出深色状态低对比、CPU单位缺失、标题副文重复，以及网站鉴权区域和动效中间态取证缺口。

已修正并重新执行三轮真实浏览器流程：等待状态改为中性高对比Tag，移除裸英文状态；CPU标为“CPU（核）”，删除重复副文；截图滚动到全站Basic用户/只写密码及路径继承控件；增加真实CSS入场暂停80ms诊断帧、真实按住主按钮的反馈及过渡结束后的弹窗图。

复核最新7张图后，评审确认以上问题均已处理，未发现新的必须修复视觉问题。具体媒体位于artifacts/screenshots/specs/059-service-image-lifecycle/evidence/ui/：current-dark.png、entry-middle-dark.png、primary-pressed-dark.png、modal-current-dark.png、round-3-installation.png、round-3-website-auth.png、round-3-website-path-auth.png。前轮motion录屏保留为历史，不用作最新状态证据。

动效边界：作者实际操作/录屏和motion探测覆盖入场、按钮/弹窗、Switch及reduced-motion；独立评审工具未连续播放视频，诊断帧可证明状态变化，不能据此声称独立评审验证了连续速度和节奏。此后台界面不适用滚动叙事。
