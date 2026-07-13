import { Fragment, useEffect, useState } from "react";
import { Button, Modal, ModalBackdrop, ModalBody, ModalCloseTrigger, ModalContainer, ModalDialog, ModalFooter, ModalHeader, ModalHeading, ModalIcon } from "@heroui/react";
import { ArrowDownToLine } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";

import { ReleaseNotes, UpdateInfo, disableUpdateChecks, installUpdate, skipUpdate } from "../../updater";

/**
 * A dialog shown on startup when a newer release of Splicedd is available.
 * Lets the user update in place, skip the offered version, dismiss the
 * dialog until the next launch, or turn off update checks altogether.
 */
export default function UpdateModal({ update, onDismiss }: {
  update: UpdateInfo,
  onDismiss: () => void
}) {
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<{ downloaded: number, total: number | null }>(
      "update-download-progress",
      ev => setProgress(ev.payload.total ? ev.payload.downloaded / ev.payload.total : null)
    );

    return () => { unlisten.then(x => x()); };
  }, []);

  async function handleUpdate() {
    setDownloading(true);
    setError(null);

    try {
      // If this succeeds, the installer is running and the app is about to exit.
      await installUpdate(update);

      // When there's no installer for this platform, `installUpdate` just opens
      // the release page in the browser and returns without exiting the app.
      // Dismiss the (otherwise un-closable) dialog instead of leaving it stuck
      // showing "Downloading...".
      if (update.installerUrl == null)
        onDismiss();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDownloading(false);
      setProgress(null);
    }
  }

  function handleSkip() {
    skipUpdate(update);
    onDismiss();
  }

  function handleDisable() {
    disableUpdateChecks();
    onDismiss();
  }

  return (
    <Modal isOpen onOpenChange={open => { if (!open && !downloading) onDismiss(); }}>
      <ModalBackdrop>
        <ModalContainer size="lg">
          <ModalDialog>
            { !downloading && <ModalCloseTrigger /> }

            <ModalHeader className="flex-row items-center gap-3">
              <ModalIcon className="bg-default text-foreground">
                <ArrowDownToLine className="size-5" />
              </ModalIcon>
              <div className="flex flex-col min-w-0">
                <ModalHeading className="text-base font-semibold tracking-tight">
                  Update available
                </ModalHeading>
                <p className="text-sm text-muted">
                  Splicedd {update.version} is out. You're on {update.currentVersion}.
                </p>
              </div>
            </ModalHeader>

            <ModalBody className="flex flex-col gap-4">
              { update.changelog.length > 0 &&
                <Changelog releases={update.changelog} />
              }

              { update.installerUrl == null &&
                <p className="text-sm text-muted">
                  No installer for this platform was found in the release, so updating opens the release page in your browser.
                </p>
              }

              { error != null &&
                <p className="text-sm text-danger">
                  Something went wrong while updating: {error}
                </p>
              }
            </ModalBody>

            <ModalFooter className="flex-col items-stretch gap-4">
              <div className="flex gap-2 justify-center">
                <Button variant="outline" isDisabled={downloading} onClick={handleSkip}>
                  Skip this version
                </Button>
                <Button variant="outline" isDisabled={downloading} onClick={onDismiss}>
                  Later
                </Button>
                <Button variant="primary" isDisabled={downloading} onClick={handleUpdate}>
                  { downloading
                    ? progress != null
                      ? `Downloading... ${Math.round(progress * 100)}%`
                      : "Downloading..."
                    : "Update now" }
                </Button>
              </div>

              <button
                type="button"
                onClick={handleDisable}
                disabled={downloading}
                className="text-xs text-muted text-center underline underline-offset-2
                           cursor-pointer hover:text-foreground transition-colors"
              >
                Don't ask about updates again
              </button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}

/**
 * Renders the release notes for one or more versions in a scrollable list,
 * newest first. Each version is labelled only when more than one is shown, so
 * a single update doesn't repeat the version already named in the header.
 */
function Changelog({ releases }: { releases: ReleaseNotes[] }) {
  return (
    <div className="flex flex-col gap-4 max-h-72 overflow-y-auto rounded-lg
                    bg-default/40 px-4 py-3 text-sm">
      { releases.map((release, i) => (
        <section key={release.tag} className="flex flex-col gap-1.5">
          { releases.length > 1 &&
            <h3 className="text-base font-semibold tracking-tight text-foreground">
              Version {release.version}
            </h3>
          }

          { release.notes.length > 0
            ? <ReleaseNotesBody notes={release.notes} />
            : <p className="text-muted italic">No release notes were provided.</p>
          }

          { i < releases.length - 1 &&
            <hr className="mt-2 border-default" />
          }
        </section>
      )) }
    </div>
  );
}

/**
 * A minimal markdown renderer for GitHub release bodies. It covers the small
 * subset those bodies actually use: headings, bullet lists, paragraphs, and
 * inline bold, code, links, and bare URLs. Anything fancier is shown verbatim.
 */
function ReleaseNotesBody({ notes }: { notes: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = notes.split(/\r?\n/);

  let bullets: string[] = [];
  const flushBullets = () => {
    if (bullets.length == 0)
      return;

    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="flex flex-col gap-1 pl-4 list-disc marker:text-muted">
        { items.map((item, i) => <li key={i}>{renderInline(item)}</li>) }
      </ul>
    );
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() == "") {
      flushBullets();
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet != null) {
      bullets.push(bullet[1]);
      continue;
    }

    flushBullets();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading != null) {
      blocks.push(
        <h4 key={`h-${blocks.length}`} className="font-semibold text-foreground">
          {renderInline(heading[2])}
        </h4>
      );
      continue;
    }

    blocks.push(
      <p key={`p-${blocks.length}`} className="text-foreground/90">
        {renderInline(line)}
      </p>
    );
  }

  flushBullets();

  return <div className="flex flex-col gap-2">{blocks}</div>;
}

// Matches, in order: **bold**, `code`, [text](url), and bare http(s) URLs.
const INLINE_PATTERN = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(https?:\/\/\S+)/g;

function renderInline(text: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(text)) != null) {
    if (match.index > last)
      nodes.push(<Fragment key={key++}>{text.slice(last, match.index)}</Fragment>);

    if (match[2] != null) {
      nodes.push(<strong key={key++} className="font-semibold text-foreground">{match[2]}</strong>);
    } else if (match[4] != null) {
      nodes.push(
        <code key={key++} className="rounded bg-default px-1 py-0.5 font-mono text-[0.85em]">
          {match[4]}
        </code>
      );
    } else if (match[6] != null) {
      nodes.push(<ExternalLink key={key++} href={match[7]}>{match[6]}</ExternalLink>);
    } else if (match[8] != null) {
      nodes.push(<ExternalLink key={key++} href={match[8]}>{shortenUrl(match[8])}</ExternalLink>);
    }

    last = INLINE_PATTERN.lastIndex;
  }

  if (last < text.length)
    nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);

  return nodes;
}

/** Drops the scheme and any trailing slash so bare URLs read less noisily. */
function shortenUrl(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** A link that opens in the system browser rather than navigating the webview. */
function ExternalLink({ href, children }: { href: string, children: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={e => { e.preventDefault(); open(href).catch(() => {}); }}
      className="text-primary underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  );
}
