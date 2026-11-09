import { markdown } from '../../public/markdown.js';
export function Markdown({ text }: { text: string }) {
  return <div className="prose" dangerouslySetInnerHTML={{ __html: markdown(text) }} />;
}
