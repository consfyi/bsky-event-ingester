import { useLingui } from "@lingui/react/macro";
import { BoxProps, Image, Box } from "@mantine/core";
import { useMemo } from "react";
import classes from "./Flag.module.css";

export default function Flag({
  country,
  size,
  ...props
}: { country: string; size: number } & Omit<BoxProps, "w" | "h">) {
  const { i18n } = useLingui();
  const countryNames = useMemo(
    () => new Intl.DisplayNames(i18n.locale, { type: "region" }),
    [i18n.locale]
  );

  const countryName = useMemo(() => countryNames.of(country), [country]);

  return (
    <Box
      component="span"
      className={classes.flag}
      h={size}
      w={(size / 3) * 4}
      {...props}
    >
      <Image
        src={`https://cdn.jsdelivr.net/npm/flagpack@latest/flags/4x3/${country.toLowerCase()}.svg`}
        title={countryName}
        alt={countryName}
      />
    </Box>
  );
}
