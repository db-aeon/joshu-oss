import { getLineHeight } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  MARKDOWN_TEXT_ELEMENT_CUSTOM_DATA_KEY,
  newTextElement,
  syncInvalidIndices,
} from "@excalidraw/element";

import type { MarkdownFile } from "./file";

/** Insert markdown source as a WYSIWYG-backed Excalidraw text element. */
export function loadMarkdownDocument(
  api: ExcalidrawImperativeAPI,
  file: MarkdownFile,
  options?: { replace?: boolean },
) {
  const appState = api.getAppState();
  const fontFamily = appState.currentItemFontFamily;
  const viewportWidth = Math.max(640, appState.width || window.innerWidth || 800);
  const viewportHeight = Math.max(480, appState.height || window.innerHeight || 600);
  const elementWidth = Math.min(920, Math.round(viewportWidth * 0.82));
  const textElement = newTextElement({
    x: options?.replace ? 80 : -appState.scrollX + viewportWidth / 2,
    y: options?.replace ? 80 : -appState.scrollY + viewportHeight / 2,
    width: elementWidth,
    strokeColor: appState.currentItemStrokeColor,
    backgroundColor: appState.currentItemBackgroundColor,
    fillStyle: appState.currentItemFillStyle,
    strokeWidth: appState.currentItemStrokeWidth,
    strokeStyle: appState.currentItemStrokeStyle,
    roughness: appState.currentItemRoughness,
    opacity: appState.currentItemOpacity,
    text: file.markdown,
    fontSize: appState.currentItemFontSize,
    fontFamily,
    textAlign: appState.currentItemTextAlign,
    verticalAlign: "top",
    lineHeight: getLineHeight(fontFamily),
    customData: {
      [MARKDOWN_TEXT_ELEMENT_CUSTOM_DATA_KEY]: true,
      sourceFileName: file.name,
    },
  });

  const existing = options?.replace
    ? []
    : (api.getSceneElementsIncludingDeleted?.() ?? api.getSceneElements());
  const nextElements = syncInvalidIndices([...existing, textElement]);

  api.updateScene({
    elements: nextElements,
    appState: {
      selectedElementIds: { [textElement.id]: true },
      selectedGroupIds: {},
      editingTextElement: null,
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  api.scrollToContent?.(textElement, { animate: true });
  api.setToast?.({
    message: `Opened ${file.name} as Markdown text`,
    duration: 3000,
  });
}
