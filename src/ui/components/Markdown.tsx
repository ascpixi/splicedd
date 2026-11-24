import ReactMarkdown, { Components, Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { open } from "@tauri-apps/plugin-shell";

import { createLogger } from "../../log";

const log = createLogger("markdown");

// GitHub turns single newlines into line breaks in release bodies.
const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm, remarkBreaks];

// Release bodies embed raw HTML (GitHub inserts pasted images as `<img>` tags).
// The sanitizer has to run after it's parsed; its default schema mirrors GitHub's.
const REHYPE_PLUGINS: Options["rehypePlugins"] = [rehypeRaw, rehypeSanitize];

const COMPONENTS: Components = {
  h1: ({ children }) => <SectionHeading>{children}</SectionHeading>,
  h2: ({ children }) => <SectionHeading>{children}</SectionHeading>,
  h3: ({ children }) => <SubHeading>{children}</SubHeading>,
  h4: ({ children }) => <SubHeading>{children}</SubHeading>,
  h5: ({ children }) => <SubHeading>{children}</SubHeading>,
  h6: ({ children }) => <SubHeading>{children}</SubHeading>,

  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,

  ul: ({ children }) => (
    <ul className="flex flex-col gap-1 pl-5 list-disc marker:text-muted">{children}</ul>
  ),

  ol: ({ children, start }) => (
    <ol start={start} className="flex flex-col gap-1 pl-5 list-decimal marker:text-muted">{children}</ol>
  ),

  // Nested lists and the paragraphs of "loose" items need spacing of their own.
  li: ({ children, className }) => (
    <li
      className={`[&>ul]:mt-1 [&>ol]:mt-1 [&>p+p]:mt-2
                  ${className?.includes("task-list-item") ? "list-none -ml-5" : ""}`}
    >
      {children}
    </li>
  ),

  input: ({ checked }) => (
    <input type="checkbox" checked={checked ?? false} disabled readOnly className="mr-1.5 align-middle" />
  ),

  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,

  // Images on their own also get the gap between blocks, but ones that follow
  // a line break don't - the larger top margin there makes up for it.
  img: ({ src, alt, title, width, height }) => (
    <img
      src={src}
      alt={alt}
      title={title}
      width={width}
      height={height}
      draggable={false}
      className="my-3 [br+&]:mt-5 max-w-full h-auto rounded-md"
    />
  ),

  code: ({ children }) => (
    <code className="rounded bg-default px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),

  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md bg-default p-3 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),

  blockquote: ({ children }) => (
    <blockquote className="flex flex-col gap-2 border-l-2 border-default pl-3 text-muted">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="my-1 border-default" />,

  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="border-collapse">{children}</table>
    </div>
  ),

  th: ({ children, style }) => (
    <th style={style} className="border border-default px-2 py-1 font-semibold text-foreground">{children}</th>
  ),

  td: ({ children, style }) => (
    <td style={style} className="border border-default px-2 py-1">{children}</td>
  )
};

/** Renders GitHub-flavored markdown, including the subset of HTML that GitHub allows. */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="flex flex-col gap-2 wrap-anywhere text-foreground/90">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4
      className="mt-3 first:mt-0 mb-1 border-b border-default pb-1.5
                 text-base font-semibold tracking-tight text-foreground"
    >
      {children}
    </h4>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h5 className="mt-2 first:mt-0 font-semibold text-foreground">{children}</h5>;
}

/** A link that opens in the system browser rather than navigating the webview. */
function ExternalLink({ href, children }: { href?: string, children: React.ReactNode }) {
  // The sanitizer drops URLs with unsafe protocols.
  if (!href)
    return <>{children}</>;

  return (
    <a
      href={href}
      onClick={e => {
        e.preventDefault();
        open(href).catch(err => log.warn("failed to open link", { href, err }));
      }}
      className="text-primary underline underline-offset-2 hover:opacity-80"
    >
      {children === href ? shortenUrl(href) : children}
    </a>
  );
}

/** Drops the scheme and any trailing slash so bare URLs read less noisily. */
function shortenUrl(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
