import { useLingui } from "@lingui/react/macro";
import { Select } from "@mantine/core";
import { IconLanguage } from "@tabler/icons-react";
import { useMemo } from "react";
import LOCALES from "~/locales";
import { useLinguiContext } from "./LinguiProvider";

export default function LocaleSelector() {
  const { i18n } = useLingui();
  const { setLocale, pending } = useLinguiContext();

  const items = useMemo(() => {
    return Object.keys(LOCALES).map((locale) => ({
      value: locale,
      label:
        new Intl.DisplayNames(locale, {
          type: "language",
        }).of(locale) ?? locale,
    }));
  }, []);

  return (
    <Select
      withCheckIcon={false}
      leftSection={<IconLanguage stroke={1.5} size={18} />}
      size="xs"
      mb="sm"
      value={i18n.locale}
      disabled={pending}
      onChange={(value) => {
        if (value == null) {
          return;
        }
        setLocale(value);
      }}
      data={items}
    />
  );
}
