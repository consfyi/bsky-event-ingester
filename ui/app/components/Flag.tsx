import { useLingui } from "@lingui/react/macro";
import { ImageProps, Image } from "@mantine/core";
import { useMemo } from "react";

export default function Flag({
  country,
  ...props
}: { country: string } & Omit<ImageProps, "src">) {
  const { i18n } = useLingui();
  const countryNames = useMemo(
    () => new Intl.DisplayNames(i18n.locale, { type: "region" }),
    [i18n.locale]
  );
  return (
    <Image
      src={`https://cdn.jsdelivr.net/npm/flagpack@latest/flags/4x3/${country.toLowerCase()}.svg`}
      title={countryNames.of(country)}
      alt={countryNames.of(country)}
      fit="contain"
      radius={1.5}
      {...props}
    />
  );
}
