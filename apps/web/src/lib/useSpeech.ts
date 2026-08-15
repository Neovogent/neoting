import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hand-declared because the Web Speech API is only half in `lib.dom.d.ts`:
 * TypeScript ships `SpeechRecognitionResultList` (and the `Result` /
 * `Alternative` it indexes to, reused below) but not the recognition object,
 * its result event, or the constructor on `window`. Only the members this hook
 * actually touches are declared — this is not, and should not become, the spec.
 */
interface SpeechRecognitionResultEvent {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognizer {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognizer;
    webkitSpeechRecognition?: new () => SpeechRecognizer;
  }
}

/**
 * Push-to-talk dictation for the workspace (PRD section 9).
 *
 * Voice is an input method only: the live transcript is surfaced for the user to
 * edit and confirm, then it enters the same command processor as typed chat.
 * Nothing is ever executed straight off the microphone.
 */
export function useSpeech(onTranscript: (text: string, isFinal: boolean) => void) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef<SpeechRecognizer | null>(null);
  const callbackRef = useRef(onTranscript);
  callbackRef.current = onTranscript;

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-GB';

    recognition.onresult = (event: SpeechRecognitionResultEvent) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        // The loop bound keeps `i` inside the list and every result carries at
        // least one alternative, so both lookups always hit; the optional
        // chaining restates that for `noUncheckedIndexedAccess`, and the ''
        // fallback appends nothing in the case that cannot happen.
        const result = event.results[i];
        const chunk = result?.[0]?.transcript ?? '';
        if (result?.isFinal) final += chunk;
        else interim += chunk;
      }
      if (final) callbackRef.current(final, true);
      else if (interim) callbackRef.current(interim, false);
    };

    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);

    recognitionRef.current = recognition;
    return () => {
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    };
  }, []);

  const start = useCallback(() => {
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.start();
      setListening(true);
    } catch {
      /* already running */
    }
  }, []);

  const stop = useCallback(() => {
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.stop();
    } catch {
      /* already stopped */
    }
    setListening(false);
  }, []);

  return { listening, supported, start, stop, toggle: () => (listening ? stop() : start()) };
}
