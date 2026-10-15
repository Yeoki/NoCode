/** Format model output for people while keeping protocol payloads untouched. */
export function formatAssistantOutput(content: string): string {
  let text = content.trim();
  if (!text) return "(empty response)";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "string") {
        const next = value.trim();
        if (!next || next === text) return next || "(empty response)";
        text = next;
        continue;
      }
      if (value !== null && typeof value === "object") return JSON.stringify(value, null, 2);
      return String(value);
    } catch { break; }
  }
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) {
    try {
      const value: unknown = JSON.parse(fenced[1]!);
      if (value !== null && typeof value === "object") return JSON.stringify(value, null, 2);
    } catch { /* preserve malformed fenced text */ }
  }
  return text;
}

export function formatConfirmationJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
