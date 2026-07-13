import { ReactNode } from "react";
import { Button, InputGroup, InputGroupInput, InputGroupPrefix, Link, ModalBody, ModalFooter, ModalHeader, ModalHeading, ModalIcon, Switch, SwitchControl, SwitchThumb } from "@heroui/react";
import { FolderOpen, Wrench } from "lucide-react";
import BrowseButton from "./BrowseButton";
import { cfg, mutateCfg, mutateCfgSync, useCfgSyncedState } from "../../config";
import { refreshDarkMode } from "../theming";
import { FIELD_BUTTON_CLASSES } from "../fieldStyles";

/**
 * A single settings row: a title with a short description on the left and,
 * optionally, a control (e.g. a switch) on the right and/or a full-width
 * control below (passed as `children`).
 */
function SettingRow({ title, description, control, children }: {
  title: string,
  description: string,
  control?: ReactNode,
  children?: ReactNode
}) {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-8">
        <div className="space-y-0.5 min-w-0">
          <h4 className="text-sm font-medium text-foreground">{title}</h4>
          <p className="text-sm text-muted">{description}</p>
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children}
    </div>
  );
}

export default function SettingsModalContent({ onClose }: { onClose: () => void }) {
  const sampleDir = useCfgSyncedState<string>("sampleDir");
  const placeholders = useCfgSyncedState<boolean>("placeholders");
  const darkMode = useCfgSyncedState<boolean>("darkMode");
  const checkUpdates = useCfgSyncedState<boolean>("checkUpdates");

  function closeFirstTimeSetup() {
    mutateCfg({ configured: true });
    onClose();
  }

  function changeDarkMode(enabled: boolean) {
    mutateCfgSync(enabled, darkMode);
    refreshDarkMode();
  }

  return (
    <>
      <ModalHeader className="flex-row items-center gap-3">
        <ModalIcon className="bg-default text-foreground">
          <Wrench className="size-5" />
        </ModalIcon>
        <div className="flex flex-col min-w-0">
          <ModalHeading className="text-base font-semibold tracking-tight">
            { cfg().configured ? "Settings" : "Welcome to Splicedd" }
          </ModalHeading>
          <p className="text-sm text-muted">
            { cfg().configured
              ? "Adjust how Splicedd stores and downloads samples."
              : "Tell Splicedd where to keep your samples and you're good to go." }
          </p>
        </div>
      </ModalHeader>

      <ModalBody>
        <div className="divide-y divide-separator">
          <SettingRow
            title="Sample folder"
            description="Downloaded samples are saved here. Drags into your DAW read from this folder."
          >
            <div className="flex gap-2 mt-3">
              <InputGroup className="flex-1">
                <InputGroupPrefix>
                  <FolderOpen className="size-4 text-muted" />
                </InputGroupPrefix>
                <InputGroupInput
                  type="text" required
                  placeholder='e.g. "D:/Samples/splice"'
                  value={ cfg().sampleDir }
                  onChange={ x => mutateCfgSync(x.target.value, sampleDir) }
                />
              </InputGroup>

              <BrowseButton variant="outline" className={FIELD_BUTTON_CLASSES} directory
                onPick={ x => mutateCfgSync(x, sampleDir) }
              >Browse</BrowseButton>
            </div>
          </SettingRow>

          <SettingRow
            title="Placeholder files"
            description="Drag samples into your DAW before they finish downloading. Some DAWs may not like this."
            control={
              <Switch
                isSelected={ cfg().placeholders }
                onChange={ x => mutateCfgSync(x, placeholders) }
                aria-label="Enable placeholder files"
              >
                <SwitchControl><SwitchThumb /></SwitchControl>
              </Switch>
            }
          />

          <SettingRow
            title="Check for updates"
            description="Ask to update when a new version of Splicedd is available."
            control={
              <Switch
                isSelected={ cfg().checkUpdates }
                onChange={ x => mutateCfgSync(x, checkUpdates) }
                aria-label="Enable update checks"
              >
                <SwitchControl><SwitchThumb /></SwitchControl>
              </Switch>
            }
          />

          <SettingRow
            title="Dark mode"
            description="Use a dark appearance."
            control={
              <Switch
                isSelected={ cfg().darkMode }
                onChange={ changeDarkMode }
                aria-label="Enable dark mode"
              >
                <SwitchControl><SwitchThumb /></SwitchControl>
              </Switch>
            }
          />
        </div>
      </ModalBody>

      <ModalFooter className="flex-col items-stretch gap-4">
        { !cfg().configured &&
          <Button
            variant="primary"
            isDisabled={cfg().sampleDir.trim() == ""}
            onClick={closeFirstTimeSetup}
          >Get started</Button>
        }

        <p className="text-xs text-muted text-center">
          Made with
          <img src="img/blob-heart.png" alt="love" className="w-3.5 inline mx-1 align-text-bottom" />
          by <Link className="text-xs" href="https://ascpixi.github.io" target="_blank">@ascpixi</Link>
          {" · "}
          <Link className="text-xs" href="https://github.com/ascpixi/splicedd" target="_blank">GitHub</Link>
        </p>
      </ModalFooter>
    </>
  );
}
