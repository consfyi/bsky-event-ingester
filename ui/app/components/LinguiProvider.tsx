import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { useEffect, useState } from "react";
import { negotiateLanguages } from "@fluent/langneg";

const AVAILABLE_LOCALES = Object.keys(
  import.meta.glob("../locales/*/messages.po")
).map((path) => path.replace(/..\/locales\/([^/]+)\/messages.po/, "$1"));

function getNegotiatedBrowserLocale() {
  const [negotiatedLocale] = negotiateLanguages(
    navigator.languages,
    AVAILABLE_LOCALES,
    {
      defaultLocale: "en",
      strategy: "matching",
    }
  );
  return negotiatedLocale;
}

async function loadCatalog(locale: string) {
  const { messages } = await import(`../locales/${locale}/messages.po`);
  i18n.load(locale, messages);
}

export function LinguiProvider({
  children,
  loadingPlaceholder,
}: {
  children: React.ReactNode;
  loadingPlaceholder?: React.ReactNode;
}) {
  const [isReady, setIsReady] = useState(false);
  const [locale] = useState(() => getNegotiatedBrowserLocale());

  useEffect(() => {
    (async () => {
      await loadCatalog(locale);
      i18n.activate(locale);
      setIsReady(true);
    })();
  }, [locale, setIsReady]);

  if (!isReady) {
    return loadingPlaceholder;
  }

  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
