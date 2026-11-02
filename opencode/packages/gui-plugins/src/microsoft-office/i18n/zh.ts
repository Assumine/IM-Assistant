import en from "./en"

export default {
  "pages.one": "{{count}} 页",
  "pages.other": "{{count}} 页",
  "slides.one": "{{count}} 张幻灯片",
  "slides.other": "{{count}} 张幻灯片",
  "sheets.one": "{{count}} 个工作表",
  "sheets.other": "{{count}} 个工作表",
  page: "第 {{number}} 页",
  slide: "第 {{number}} 张幻灯片",
  hiddenSlide: "已隐藏的幻灯片",
  slideFailed: "无法显示这张幻灯片",
  speakerNotes: "演讲者备注",
  "sheet.copyTooLarge": "选中区域太大，无法复制",
  "sheet.copyFailed": "无法复制单元格",
  "sheet.openFailed": "无法打开工作表",
  "sheet.paintFailed": "无法显示工作表的这个区域",
  "sheet.tabs": "工作表",
  "problem.compound": "这个文件受密码保护，或使用较旧的 Office 格式保存。",
  "problem.format": "这个文件不是有效的 Office 文档。",
} satisfies Record<keyof typeof en, string>
