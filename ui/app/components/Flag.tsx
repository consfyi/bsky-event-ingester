import { useLingui } from "@lingui/react/macro";
import { ImageProps, Image } from "@mantine/core";
import { useMemo } from "react";

export default function Flag({
  country,
  ...props
}: { country: string } & Omit<ImageProps, "src">) {
  const { i18n } = useLingui();
  const countryNames = useMemo(
    () => new Intl.DisplayNames(i18n.locales, { type: "region" }),
    [i18n]
  );
  return (
    <Image
      src={`https://flagcdn.com/${country.toLowerCase()}.svg`}
      title={countryNames.of(country)}
      alt={countryNames.of(country)}
      {...props}
    />
  );
}
