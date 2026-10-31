import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Release notes are untrusted input (anyone can publish a release on a repo a user tracks).
 *
 * Pipeline: markdown → GFM (tables, task lists, strikethrough, autolinks) → mdast → hast →
 * `rehype-raw` parses inline HTML (GitHub notes routinely use <details>, <img>, <br>) →
 * `rehype-sanitize` with GitHub's own allow-list strips <script>, <iframe>, <style>, event
 * handlers (onerror=…), `javascript:` URLs, inline styles, etc. → `rehype-highlight` adds
 * highlight.js classes *after* sanitizing, so it only ever touches already-safe code nodes.
 */
const sanitizeSchema = defaultSchema; // GitHub's allow-list (only disabled checkbox <input>s survive).

const components: Components = {
  a({ node: _node, href, children, ...props }) {
    // Absolute and protocol-relative (`//host/…`) URLs leave the app.
    const external = typeof href === "string" && /^(https?:)?\/\//i.test(href);
    return (
      <a href={href} {...props} {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow ugc" } : {})}>
        {children}
      </a>
    );
  },
  img({ node: _node, alt, ...props }) {
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary third-party hosts, no Next image optimizer
    return <img alt={alt ?? ""} loading="lazy" decoding="async" referrerPolicy="no-referrer" {...props} />;
  },
  table({ node: _node, ...props }) {
    // Wide changelog tables scroll inside the reader instead of stretching it.
    return (
      <div className="overflow-x-auto">
        <table {...props} />
      </div>
    );
  },
};

export function ChangelogMarkdown({ markdown, className }: { markdown: string; className?: string }) {
  if (!markdown.trim()) {
    return <p className="text-sm italic text-muted-foreground">This release has no release notes.</p>;
  }
  return (
    <div
      className={cn(
        "changelog prose prose-sm prose-zinc max-w-none dark:prose-invert",
        "prose-headings:scroll-mt-4 prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline dark:prose-a:text-blue-400",
        "prose-pre:rounded-lg prose-pre:border prose-pre:bg-muted prose-pre:text-[13px] prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none",
        "prose-img:inline-block prose-img:my-1 prose-li:my-0.5 prose-table:text-xs",
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-normal",
        "[&_details]:my-3 [&_details]:rounded-md [&_details]:border [&_details]:px-3 [&_details]:py-2 [&_summary]:cursor-pointer [&_summary]:font-medium",
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], [rehypeHighlight, { detect: false }]]}
        components={components}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
