export function firstNonEmptyLine(text: string): string {
    return (
        text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean) ?? ""
    );
}

export function filterConflictingExtraArgs(args: string[]): {
  filtered: string[];
  dropped: string[];
} {
  const filtered: string[] = [];
  const dropped: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === "--yolo" || token === "-y") {
      dropped.push(token);
      i++;
    } else if (token === "--approval-mode") {
      dropped.push(token);
      i++;
      if (i < args.length) {
        dropped.push(args[i]);
        i++;
      }
    } else if (token.startsWith("--approval-mode=")) {
      dropped.push(token);
      i++;
    } else {
      filtered.push(token);
      i++;
    }
  }
  return { filtered, dropped };
}
