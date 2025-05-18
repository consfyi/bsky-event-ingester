import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { useEffect, useState } from "react";

async function loadCatalog(locale: string) {
  const { messages } = await import(`../locales/${locale}/messages.po`);
  i18n.loadAndActivate({ locale, messages });
}

export function LinguiProvider({
  children,
  loadingPlaceholder,
}: {
  children: React.ReactNode;
  loadingPlaceholder?: React.ReactNode;
}) {
  const [isI18nReady, setIsI18nReady] = useState(false);
  const [currentLocale] = useState("en");

  useEffect(() => {
    (async () => {
      await loadCatalog(currentLocale);
      setIsI18nReady(true);
    })();
  }, [currentLocale]);

  if (!isI18nReady) {
    return loadingPlaceholder;
  }

  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
