import { Button, ButtonProps } from "@heroui/react";
import { open } from "@tauri-apps/plugin-dialog";
import { createLogger } from "../../log";

const log = createLogger("browse");

/**
 * Renders a button which, when clicked, will prompt the user to select a file-system entry.
 */
export default function BrowseButton(props: ButtonProps & {
  onPick: (path: string) => void,
  directory?: boolean,
  title?: string
}) {
  async function handleClick() {
    const path = await open({
      directory: props.directory,
      title: props.title
    });

    log.debug("dialog closed", { path });

    if (typeof path == "string") {
      props.onPick(path);
    }
  }

  return <Button {...props} onClick={handleClick}>{props.children}</Button>
}
