import { match } from "@formatjs/intl-localematcher";
import { i18n, Locale } from "@lingui/core";
import { I18nProvider, I18nProviderProps } from "@lingui/react";
import { Direction, useDirection } from "@mantine/core";
import IntlLocale from "intl-locale-textinfo-polyfill";
import { createContext, useContext, useEffect, useState } from "react";
import LOCALES from "~/locales";

const LOCALE_KEY = "fbl:locale";

function getRequestedLocales(): Locale[] {
  const requestedLocales: string[] = [];

  if (typeof window !== "undefined") {
    const searchParams = new URLSearchParams(location.search);
    requestedLocales.push(...searchParams.getAll("lang"));

    const storedLocale = window.localStorage.getItem(LOCALE_KEY);
    if (storedLocale != null) {
      requestedLocales.push(storedLocale);
    }
  }

  requestedLocales.push(...navigator.languages);
  return requestedLocales;
}

async function loadAndActivate(locale: string) {
  const { messages } = await LOCALES[locale]();
  i18n.loadAndActivate({ locale, messages });
  window.localStorage.setItem(LOCALE_KEY, locale);
}

export const INITIAL_LOCALE = match(
  getRequestedLocales(),
  Object.keys(LOCALES),
  "en-US"
);

const LinguiContext = createContext<{
  locale: string;
  pending: boolean;
  setLocale: (locale: Locale) => void;
} | null>(null);

export default function LinguiProvider(props: Omit<I18nProviderProps, "i18n">) {
  useEffect(() => {
    (async () => {
      await loadAndActivate(INITIAL_LOCALE);
    })();
  }, []);

  const [pending, setPending] = useState(false);
  const [locale, setLocale] = useState(INITIAL_LOCALE);

  const { setDirection } = useDirection();

  useEffect(() => {
    (async () => {
      setPending(true);
      await loadAndActivate(locale);
      setDirection(new IntlLocale(locale).textInfo.direction as Direction);
      document.documentElement.lang = locale;
      setPending(false);
    })();
  }, [locale, setDirection, setPending]);

  return (
    <LinguiContext.Provider value={{ locale, pending, setLocale }}>
      <I18nProvider i18n={i18n} {...props} />
    </LinguiContext.Provider>
  );
}

export function useLinguiContext() {
  return useContext(LinguiContext)!;
}
