export type MarkdownFile = {
  name: string;
  markdown: string;
  fileHandle: FileSystemFileHandle | null;
};

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkdn"];

export const isMarkdownPath = (path: string) => {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

export const isMarkdownFile = (file: File) => {
  const name = file.name.toLowerCase();

  return (
    MARKDOWN_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
    file.type === "text/markdown"
  );
};

export const readMarkdownFile = async (
  file: File,
  fileHandle: FileSystemFileHandle | null = null,
): Promise<MarkdownFile> => {
  return {
    name: file.name || "Untitled.md",
    markdown: await file.text(),
    fileHandle,
  };
};

const getWindowWithFilePicker = () => {
  return window as typeof window & {
    showOpenFilePicker?: (options?: {
      types?: Array<{
        description: string;
        accept: Record<string, string[]>;
      }>;
      multiple?: boolean;
    }) => Promise<FileSystemFileHandle[]>;
  };
};

const markdownPickerOptions = {
  types: [
    {
      description: "Markdown files",
      accept: {
        "text/markdown": MARKDOWN_EXTENSIONS,
        "text/plain": [".md"],
      },
    },
  ],
};

const openWithInput = () => {
  return new Promise<MarkdownFile | null>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = MARKDOWN_EXTENSIONS.join(",");

    input.onchange = async () => {
      const file = input.files?.[0];

      if (!file) {
        resolve(null);
        return;
      }

      try {
        resolve(await readMarkdownFile(file));
      } catch (error) {
        reject(error);
      }
    };

    input.click();
  });
};

export const openMarkdownFile = async () => {
  const pickerWindow = getWindowWithFilePicker();

  if (pickerWindow.showOpenFilePicker) {
    const [fileHandle] = await pickerWindow.showOpenFilePicker({
      ...markdownPickerOptions,
      multiple: false,
    });

    if (!fileHandle) {
      return null;
    }

    return readMarkdownFile(await fileHandle.getFile(), fileHandle);
  }

  return openWithInput();
};
