import { Button, Input, Link, ModalBody, ModalContent, ModalHeader, Switch } from "@nextui-org/react";
import { FolderOpenIcon } from "@heroicons/react/20/solid";
import BrowseButton from "./BrowseButton";
import { cfg, mutateCfg, mutateCfgSync, useCfgSyncedState } from "../../config";
import { refreshDarkMode } from "../theming";

export default function SettingsModalContent() {
  const sampleDir = useCfgSyncedState<string>("sampleDir");
  const placeholders = useCfgSyncedState<boolean>("placeholders");
  const darkMode = useCfgSyncedState<boolean>("darkMode");

  function closeFirstTimeSetup(onClose: () => void) {
    mutateCfg({ configured: true });
    onClose();
  }

  function changeDarkMode(enabled: boolean) {
    mutateCfgSync(enabled, darkMode);
    refreshDarkMode();
  }

  return <ModalContent>
    {(onClose) => (
      <>
        <ModalHeader className="flex flex-col gap-1">
          { cfg().configured ? "Settings" : "First-time configuration" }
        </ModalHeader>
        <ModalBody className="pb-8 ml-2">
          <div className="space-y-4">
            <div className="space-y-1">
              <h4 className="text-medium font-medium">Sample path</h4>
              <p className="text-small text-default-400">
                The folder where downloaded Splice samples should be saved to. When dragging
                samples into a DAW, this will be the directory it will read from.
              </p>
            </div>

            <div className="flex gap-2">
              <Input
                type="text" required variant="bordered"
                placeholder='e.g. "D:/Samples/splice"'
                value={ cfg().sampleDir }
                onChange={ x => mutateCfgSync(x.target.value, sampleDir) }
                startContent={
                  <FolderOpenIcon className="w-4 text-foreground-500 mt-1 mr-1" />
                }
              />

              <BrowseButton variant="bordered" directory
                onPick={ x => mutateCfgSync(x, sampleDir) }
              >Browse</BrowseButton>
            </div>

            <div className="space-y-1">
              <h4 className="text-medium font-medium">Placeholders</h4>
              <p className="text-small text-default-400">
                While downloading samples, Splicedd has the ability to create placeholder files, which
                will be replaced when the downloading finishes. This avoids the need to wait before
                drag-and-dropping is allowed, but might cause issues in certain DAWs.
              </p>
            </div>

            <div>
              <Switch isSelected={ cfg().placeholders } onValueChange={x  => mutateCfgSync(x, placeholders) }>
                  Enable placeholders
                </Switch>
            </div>

            <div className="space-y-1">
              <h4 className="text-medium font-medium">Dark mode</h4>
              <p className="text-small text-default-400">
                Switches between light and dark mode.
              </p>
            </div>

            <div>
              <Switch isSelected={ cfg().darkMode } onValueChange={ changeDarkMode }>
                  Dark mode
                </Switch>
            </div>
          </div>

          { !cfg().configured &&
            <div className="flex">
              <Button
                color="primary" variant="ghost" className="w-full"
                isDisabled={cfg().sampleDir.trim() == ""}
                onClick={() => closeFirstTimeSetup(onClose)}
              >Apply</Button>
            </div>
          }

          <br />

          <div className="text-foreground-400 text-small">
            check out the project on <Link href="https://github.com/ascpixi/splicedd" target="_blank">GitHub!</Link>
            <br />

            (developed with
            <img src="img/blob-heart.png" className="w-4 inline mx-2"/>
            by <Link href="https://ascpixi.github.io" target="_blank">@ascpixi</Link>)
          </div>
        </ModalBody>
      </>
    )}
  </ModalContent>
}