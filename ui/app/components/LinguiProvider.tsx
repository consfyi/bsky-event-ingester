import { negotiateLanguages } from "@fluent/langneg";
import { i18n, Locale } from "@lingui/core";
import { I18nProvider, I18nProviderProps } from "@lingui/react";
import { Direction, useDirection } from "@mantine/core";
import { createContext, useContext, useEffect, useState } from "react";
import { hookifyPromise } from "~/hooks";
import IntlLocale from "intl-locale-textinfo-polyfill";

export const AVAILABLE_LOCALES = Object.keys(
  import.meta.glob("../locales/*/messages.po")
).map((path) => path.replace(/..\/locales\/([^/]+)\/messages.po/, "$1"));

const LOCALE_KEY = "fbl:locale";

function getNegotiatedBrowserLocale(): Locale {
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

  const [negotiatedLocale] = negotiateLanguages(
    requestedLocales,
    AVAILABLE_LOCALES,
    {
      defaultLocale: "en",
      strategy: "matching",
    }
  );
  return negotiatedLocale;
}

async function loadAndActivate(locale: string) {
  const { messages } = await import(`../locales/${locale}/messages.po`);
  i18n.loadAndActivate({ locale, messages });
  window.localStorage.setItem(LOCALE_KEY, locale);
}

export const INITIAL_LOCALE = getNegotiatedBrowserLocale();

const useInitialLoad = hookifyPromise(loadAndActivate(INITIAL_LOCALE));

const LinguiContext = createContext({
  locale: INITIAL_LOCALE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setLocale(_locale: Locale) {},
});

export default function LinguiProvider(props: Omit<I18nProviderProps, "i18n">) {
  useInitialLoad();

  const [locale, setLocale] = useState(INITIAL_LOCALE);

  const { setDirection } = useDirection();

  useEffect(() => {
    (async () => {
      await loadAndActivate(locale);
      setDirection(
        (new IntlLocale(locale).textInfo.direction as Direction | undefined) ??
          "ltr"
      );
    })();
  }, [locale, setDirection]);

  return (
    <LinguiContext.Provider value={{ locale, setLocale }}>
      <I18nProvider i18n={i18n} {...props} />
    </LinguiContext.Provider>
  );
}

export function useSetLocale(): (locale: Locale) => void {
  return useContext(LinguiContext).setLocale;
}
