import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangelogMarkdown } from "./changelog-markdown";

const render = (markdown: string) => renderToStaticMarkup(<ChangelogMarkdown markdown={markdown} />);

describe("ChangelogMarkdown — XSS sanitization", () => {
  it("strips <script> tags and their content", () => {
    const html = render("Hello\n\n<script>alert('xss')</script>\n\nWorld");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("alert(");
    expect(html).toContain("Hello");
    expect(html).toContain("World");
  });

  it("removes event-handler attributes such as onerror=", () => {
    const html = render(`<img src="https://example.com/x.png" onerror="alert(1)">\n\n<a href="https://example.com" onclick="steal()">x</a>`);
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/onclick/i);
    expect(html).toContain('src="https://example.com/x.png"');
  });

  it("neutralizes javascript: URLs in markdown and raw HTML links", () => {
    const html = render(`[click](javascript:alert(1))\n\n<a href="javascript:alert(2)">raw</a>\n\n<a href="JaVaScRiPt:alert(3)">mixed</a>`);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("drops iframes, styles, forms, objects and inline style attributes", () => {
    const html = render(
      `<iframe src="https://evil.example"></iframe>\n<style>body{display:none}</style>\n<form action="https://evil.example"><button>Go</button></form>\n<object data="x.swf"></object>\n<p style="position:fixed">styled</p>`,
    );
    expect(html).not.toMatch(/<iframe|<style|<form|<object|style=/i);
    expect(html).toContain("styled");
  });

  it("does not allow data: or vbscript: image sources", () => {
    const html = render(`<img src="data:text/html;base64,PHNjcmlwdD4=">\n<img src="vbscript:msgbox(1)">`);
    expect(html).not.toMatch(/data:text|vbscript:/i);
  });

  it("prefixes user ids to prevent DOM clobbering", () => {
    const html = render(`<a id="cookie" name="cookie">x</a>`);
    expect(html).not.toMatch(/\sid="cookie"/);
    expect(html).toContain("user-content-cookie");
  });
});

describe("ChangelogMarkdown — GitHub Flavored Markdown", () => {
  it("renders tables inside a horizontal scroll container", () => {
    const html = render("| Package | Version |\n| --- | --- |\n| next | 16.4.3 |");
    expect(html).toContain('<div class="overflow-x-auto"><table>');
    expect(html).toContain("<th>Package</th>");
    expect(html).toContain("<td>16.4.3</td>");
  });

  it("renders task lists, strikethrough and autolinks", () => {
    const html = render("- [x] done\n- [ ] todo\n\n~~removed~~ https://github.com/vercel/next.js");
    expect(html).toContain('<input type="checkbox" disabled="" checked=""/> done');
    expect(html).toContain('<input type="checkbox" disabled=""/> todo');
    expect(html).toContain("<del>removed</del>");
    expect(html).toContain('href="https://github.com/vercel/next.js"');
  });

  it("opens external links in a new tab without leaking the opener", () => {
    const html = render("[docs](https://nextjs.org/docs)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
  });

  it("syntax-highlights fenced code blocks after sanitizing", () => {
    const html = render("```ts\nconst answer: number = 42;\n```");
    expect(html).toContain('class="hljs language-ts"');
    expect(html).toMatch(/<span class="hljs-keyword">const<\/span>/);
  });

  it("keeps GitHub's collapsible <details> blocks", () => {
    const html = render("<details><summary>Full changelog</summary>\n\n- item\n\n</details>");
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Full changelog</summary>");
    expect(html).toContain("<li>item</li>");
  });

  it("shows a placeholder for empty release notes", () => {
    expect(render("   ")).toContain("This release has no release notes.");
  });
});
