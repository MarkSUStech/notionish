# 图标与封面优化设计

## 目标

统一 Notionish 的功能图标，提升页面图标选择体验，并内置精选封面图库。

## 决策记录

| 决策 | 备选 | 理由 |
|---|---|---|
| Lucide 本地化，不依赖 CDN | CDN 引入 / 手工 sprite | 离线可用、体积可控、维护成本低 |
| 功能图标用 Lucide，页面人格图标保留 Emoji | 全部 Lucide | 保留 Notion 式页面个性，工具图标统一克制 |
| 精选固定图库，不接动态搜索 API | Unsplash API 搜索 / 本地资源 | 无需 Key、稳定、无追踪 |
| 封面仍存字符串 `page.cover` | 引入封面元数据迁移 | 零迁移、兼容旧数据 |

## 组件

1. **`U.icon(name, opts)`**：把 `lucide.icons` 数据渲染成 SVG 字符串，兼容现有 `innerHTML` 模式；Lucide 缺失时返回空串安全降级。
2. **`U.iconName(name)`**：kebab-case → PascalCase 映射。
3. **Emoji 选择器**：分类标签 + 中文关键词搜索 + `localStorage` 最近使用（上限 24）。
4. **封面图库**：`U.COVER_CATALOG` 静态目录（自然 / 建筑 / 纹理 / 油画），含缩略图、大图、`alt`、署名与来源链接。油画分类使用 Wikimedia Commons 公有领域经典画作（`Special:FilePath` 外链）。

## 视觉约束

- 工具图标固定线性、`currentColor`，尺寸统一 18px（按钮内 16px）。
- 图标按钮固定 32×32 命中区，避免字符宽度跳动。
- 仅图标按钮保留 `title` 并补 `aria-label`。
- 封面缩略图 `loading="lazy"`，加载失败显示占位。

## 风险与降级

- Lucide 未加载：工具按钮退回空白但保留 `title`/`aria-label`，功能不受影响。
- 在线封面不可用：缩略图隐藏并提示“图片暂不可用”，渐变与本地上传始终可用。
- 署名字段以平台（Unsplash）为准，具体摄影师名待联网时逐张核对。
