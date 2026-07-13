import { Button, Link } from "@heroui/react";
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
      variant={value == selectedValue ? "primary" : "outline"}
      onClick={() => setter(value == selectedValue ? null : value)}
      className={className}
    >{display}</Button>
  }

  const keyButton = (value: MusicKey | null, display: string) =>
    stickyButton<MusicKey>(value, selectedKey, onKeySet, display, "w-10 min-w-10 p-0 shrink-0");

  const chordButton = (value: ChordType | null, display: string) =>
    stickyButton<ChordType>(value, selectedChord, onChordSet, display, "w-full");

  return (
    <div className="flex flex-col w-full gap-4">
      { /* keys, laid out like a piano octave: sharps sit between the naturals below them */}
      <div className="flex flex-col gap-1">
        <div className="flex gap-1">
          <div className="w-6 shrink-0" />
          { keyButton("C#", "C♯") }
          { keyButton("D#", "D♯") }
          <div className="w-10 shrink-0" />
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

      <div className="flex w-full gap-2">
        { chordButton("major", "Major") }
        { chordButton("minor", "Minor") }
      </div>

      <div className="flex justify-start pt-2">
        <Link href="#" onClick={() => { onChordSet(null); onKeySet(null) }}>Clear</Link>
      </div>
    </div>
  )
}
