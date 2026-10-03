# Novel Summarizer（小说总结器）

SillyTavern 第三方扩展：定期把前文剧情的小摘要（`<summary>` / `<abstract>` 等标签）压缩成一份「剧情编年史」大总结，注入到聊天记录顶部，并把已总结的楼层隐藏，适合长线剧情防遗忘。

## 安装方法

把本仓库下载（Code → Download ZIP）后解压，将 `novel_summarizer` 整个文件夹放到：

```
SillyTavern/public/scripts/extensions/third-party/
```

即最终路径为：

```
SillyTavern/public/scripts/extensions/third-party/novel_summarizer/index.js
```

然后重启 SillyTavern（或刷新页面），在 **AI 回复配置 → 扩展插件** 里找到「小说总结器」展开设置。

> 注意：文件夹名建议保持 `novel_summarizer`（与仓库同名），改名也能用，但方便以后更新。

## 使用前提

你的 AI 回复里需要带有摘要标签（可在正则 / 其他扩展中生成），例如：

```xml
<summary>本回合剧情要点……</summary>
```

插件默认提取 `summary` 标签，可在设置中填写多个标签（逗号分隔），如 `summary, abstract`。

## 主要功能

- **自动 / 手动触发**总结：每 N 条消息自动压缩一次，也可点「立即总结」
- **多摘要标签支持**：逗号分隔填多个，按顺序取第一个命中的
- **大总结常驻显示长度**，状态栏可见已总结楼层与总结字符数
- **自定义 OpenAI 兼容 API**：可选不用主模型，走自己的 API 总结
- **撤销 / 重做 / 清空**：总结错了可以回退
- **提示词模板可编辑**：默认生成「故事演进脉络 + 核心事件编年史 + 人物关系档案 + 遗留线索」结构的编年史

## 隐私说明

API Key 存在 SillyTavern 自己的全局设置里（`data/default-user/settings.json`），**不在本插件文件夹中**，分享本插件不会带走 Key。大总结内容存在聊天文件的元数据里，导出聊天记录时会一并包含。

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.js` | 插件全部逻辑 |
| `manifest.json` | ST 扩展清单 |
