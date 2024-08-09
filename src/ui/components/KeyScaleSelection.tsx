import { Button, Link } from "@nextui-org/react";
import { ChordType, MusicKey } from "../../splice/entities";

export default function KeyScaleSelection({
  selectedKey, selectedChord, onKeySet, onChordSet
}: {
  selectedKey: MusicKey | null,
  selectedChord: ChordType | null,
  onKeySet: (key: MusicKey | null) => void,
  onChordSet: (chord: ChordType | null) => void
}) {
  function stickyButton<T>(
    value: T | null,
    selectedValue: T | null,
    setter: (x: T | null) => void,
    display: string,
    className: string
  ) {
    return <Button
      color={value == selectedValue ? "primary" : "default"}
      variant={value == selectedValue ? "solid" : "bordered"}
      onClick={() => setter(value == selectedValue ? null : value)}
      className={className}
    >{display}</Button>
  }

  const keyButton = (value: MusicKey | null, display: string) =>
    stickyButton<MusicKey>(value, selectedKey, onKeySet, display, "min-w-10 p-0");

  const chordButton = (value: ChordType | null, display: string) =>
    stickyButton<ChordType>(value, selectedChord, onChordSet, display, "w-full");

  const separator = () => <div className="w-8"></div>

  return (
    <div className="flex flex-col w-full">
      <div className="flex flex-col gap-1">
        <div className="flex gap-1">
          { separator() }
          { keyButton("C#", "C♯") }
          { keyButton("D#", "D♯") }
          { separator() }
          { keyButton("F#", "F♯") }
          { keyButton("G#", "G♯") }
          { keyButton("A#", "A♯") }
        </div>

        <div className="flex gap-1">
          { keyButton("C", "C") }
          { keyButton("D", "D") }
          { keyButton("E", "E") }
          { keyButton("F", "F") }
          { keyButton("G", "G") }
          { keyButton("A", "A") }
          { keyButton("B", "B") }
        </div>
      </div>

      <br/>

      <div className="flex w-full gap-2">
        { chordButton("major", "Major") }
        { chordButton("minor", "Minor") }
      </div>

      <br/>

      <Link href="#" onClick={() => { onChordSet(null); onKeySet(null) }}>Clear</Link>
    </div>
  )
}