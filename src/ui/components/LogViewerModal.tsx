import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ListBox, ListBoxItem, ListBoxItemIndicator, Modal, ModalBackdrop, ModalBody, ModalCloseTrigger, ModalContainer, ModalDialog, ModalFooter, ModalHeader, ModalHeading, ModalIcon, Select, SelectIndicator, SelectPopover, SelectTrigger, SelectValue, toast } from "@heroui/react";
import { ScrollText } from "lucide-react";

import { createLogger, listLogFiles, LogFile, openLogDir, readLogFile } from "../../log";
import { FIELD_BUTTON_CLASSES } from "../fieldStyles";

const log = createLogger("log-viewer");

/** How many of the most recent records to display. */
const MAX_RECORDS = 2000;

/** All log levels, the most severe ones first. */
const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] as const;

type Level = typeof LEVELS[number];

const LEVEL_CLASSES: Record<Level, string> = {
  ERROR: "text-danger",
  WARN: "text-warning",
  INFO: "text-foreground",
  DEBUG: "text-muted",
  TRACE: "text-muted/70"
};

interface LogRecord {
  level: Level;
  text: string;
}

/** Splits the contents of a log file into records, which may span many lines. */
function parseLog(contents: string) {
  const records: LogRecord[] = [];

  for (const line of contents.split("\n")) {
    const level = /^\S+Z (ERROR|WARN|INFO|DEBUG|TRACE)\s/.exec(line)?.[1] as Level | undefined;

    if (level != null) {
      records.push({ level, text: line });
    }
    else if (records.length > 0 && line != "") {
      records[records.length - 1].text += "\n" + line;
    }
  }

  return records;
}

function describeFile(file: LogFile, isCurrent: boolean) {
  const size = file.size < 1024 * 1024
    ? `${Math.ceil(file.size / 1024)} KB`
    : `${(file.size / 1024 / 1024).toFixed(1)} MB`;

  return `${isCurrent ? "This session" : new Date(file.modified).toLocaleString()} (${size})`;
}

/**
 * Displays the log files of this session and the ones before it.
 */
export default function LogViewerModal({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [minLevel, setMinLevel] = useState<Level>("TRACE");
  const [contents, setContents] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);

  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const newFiles = await listLogFiles();
        const name = selected ?? newFiles[0]?.name;
        const newContents = name == null ? "" : await readLogFile(name);

        if (!cancelled) {
          setFiles(newFiles);
          setSelected(name ?? null);
          setContents(newContents);
          setError(null);
        }
      }
      catch (err) {
        log.error("failed to load the logs", { err });

        if (!cancelled) {
          setError(String(err));
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [selected, refreshes]);

  const records = useMemo(() => parseLog(contents), [contents]);

  const shown = useMemo(
    () => records
      .filter(x => LEVELS.indexOf(x.level) <= LEVELS.indexOf(minLevel))
      .slice(-MAX_RECORDS),
    [records, minLevel]
  );

  // The most recent records are at the bottom.
  useEffect(() => {
    container.current?.scrollTo({ top: container.current.scrollHeight });
  }, [shown]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(shown.map(x => x.text).join("\n"));
      toast.success("Logs copied");
    }
    catch (err) {
      log.error("failed to copy the logs", { err });
      toast.danger("Couldn't copy the logs", { description: "Please open the log folder instead." });
    }
  }

  async function handleOpenFolder() {
    try {
      await openLogDir();
    }
    catch (err) {
      log.error("failed to open the log folder", { err });
      toast.danger("Couldn't open the log folder", { description: String(err) });
    }
  }

  return (
    <Modal isOpen onOpenChange={open => !open && onClose()}>
      <ModalBackdrop>
        <ModalContainer size="cover">
          <ModalDialog className="max-h-full min-h-0">
            <ModalCloseTrigger />

            <ModalHeader className="flex-row items-center gap-3">
              <ModalIcon className="bg-default text-foreground">
                <ScrollText className="size-5" />
              </ModalIcon>
              <div className="flex flex-col min-w-0">
                <ModalHeading className="text-base font-semibold tracking-tight">Logs</ModalHeading>
                <p className="text-sm text-muted">
                  { records.length > shown.length
                    ? `Showing ${shown.length} of ${records.length} entries`
                    : "All entries shown" }
                </p>
              </div>
            </ModalHeader>

            <ModalBody className="mt-4 flex flex-col gap-3 min-h-0 flex-1">
              <div className="flex gap-2">
                <Select aria-label="Log file" className="flex-1 min-w-0" fullWidth
                  value={selected}
                  onChange={x => setSelected(x as string)}
                >
                  <SelectTrigger>
                    <SelectValue className="truncate" />
                    <SelectIndicator />
                  </SelectTrigger>
                  <SelectPopover>
                    <ListBox>
                      { files.map((x, i) => {
                        const description = describeFile(x, i == 0);
                        return (
                          <ListBoxItem key={x.name} id={x.name} textValue={description}>
                            {description}<ListBoxItemIndicator />
                          </ListBoxItem>
                        );
                      })}
                    </ListBox>
                  </SelectPopover>
                </Select>

                <Select aria-label="Minimum level" className="w-40"
                  value={minLevel}
                  onChange={x => setMinLevel(x as Level)}
                >
                  <SelectTrigger>
                    <SelectValue />
                    <SelectIndicator />
                  </SelectTrigger>
                  <SelectPopover>
                    <ListBox>
                      <ListBoxItem id="TRACE" textValue="Everything">Everything<ListBoxItemIndicator /></ListBoxItem>
                      <ListBoxItem id="DEBUG" textValue="Debug & up">Debug & up<ListBoxItemIndicator /></ListBoxItem>
                      <ListBoxItem id="INFO" textValue="Info & up">Info & up<ListBoxItemIndicator /></ListBoxItem>
                      <ListBoxItem id="WARN" textValue="Warnings & up">Warnings & up<ListBoxItemIndicator /></ListBoxItem>
                      <ListBoxItem id="ERROR" textValue="Errors only">Errors only<ListBoxItemIndicator /></ListBoxItem>
                    </ListBox>
                  </SelectPopover>
                </Select>

                <Button variant="outline" className={FIELD_BUTTON_CLASSES}
                  onClick={() => setRefreshes(x => x + 1)}
                >Refresh</Button>
              </div>

              { error != null && <p className="text-sm text-danger">Couldn't load the logs: {error}</p> }

              <div ref={container} tabIndex={0} aria-label="Log contents"
                className="flex-1 min-h-0 overflow-auto scrollbar-thin rounded-xl bg-surface-secondary p-3
                           font-mono text-xs select-text"
              >
                { shown.length == 0 && <p className="text-muted">No entries to show.</p> }
                { shown.map((x, i) =>
                  <div key={i} className={`whitespace-pre-wrap break-words ${LEVEL_CLASSES[x.level]}`}>{x.text}</div>
                )}
              </div>
            </ModalBody>

            <ModalFooter className="gap-2">
              <Button variant="outline" onClick={handleOpenFolder}>Open folder</Button>
              <Button variant="primary" isDisabled={shown.length == 0} onClick={handleCopy}>Copy shown</Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
