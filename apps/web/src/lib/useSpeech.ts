import { useCallback, useEffect, useRef, useState } from 'react';

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
  const recognitionRef = useRef<any>(null);
  const callbackRef = useRef(onTranscript);
  callbackRef.current = onTranscript;

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-GB';

    recognition.onresult = (event: any) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += chunk;
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
