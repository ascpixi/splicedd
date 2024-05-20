import { Button, ButtonProps } from "@nextui-org/react";
import { open } from "@tauri-apps/api/dialog";

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

    if (typeof path == "string") {
      props.onPick(path);
    }
  }

  return <Button {...props} onClick={handleClick}>{props.children}</Button>
}