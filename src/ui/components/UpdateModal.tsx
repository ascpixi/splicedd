import { useEffect, useState } from "react";
import { Button, Modal, ModalBackdrop, ModalBody, ModalCloseTrigger, ModalContainer, ModalDialog, ModalFooter, ModalHeader, ModalHeading, ModalIcon } from "@heroui/react";
import { ArrowDownToLine } from "lucide-react";
import { listen } from "@tauri-apps/api/event";

import { ReleaseNotes, UpdateInfo, disableUpdateChecks, installUpdate, opensReleasePage, skipUpdate } from "../../updater";
import { createLogger } from "../../log";
import Markdown from "./Markdown";

const log = createLogger("updater");

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
    setError(null);

    // On platforms without in-app install, updating just opens the release page
    // in the browser -- there's no download, so skip the "Downloading..." state
    // and dismiss the dialog once the page is open.
    if (opensReleasePage(update)) {
      try {
        await installUpdate(update);
        onDismiss();
      }
      catch (err) {
        log.error("update failed", { err });
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    setDownloading(true);
    try {
      // If this succeeds, the installer is running and the app is about to exit.
      await installUpdate(update);
    }
    catch (err) {
      log.error("update failed", { err });
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
          <ModalDialog className="max-h-full min-h-0 max-w-2xl">
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
                  { opensReleasePage(update)
                    ? "Open release page"
                    : downloading
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
            <h3 className="text-lg font-semibold tracking-tight text-foreground">
              Version {release.version}
            </h3>
          }

          { release.notes.length > 0
            ? <Markdown>{release.notes}</Markdown>
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
