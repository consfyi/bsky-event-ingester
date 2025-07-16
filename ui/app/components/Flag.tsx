import { useLingui } from "@lingui/react/macro";
import { BoxProps, Image, Box, Tooltip } from "@mantine/core";
import { useMemo } from "react";
import classes from "./Flag.module.css";

export default function Flag({
  country,
  size,
  circular = false,
  ...props
}: { country: string; size: number; circular?: boolean } & Omit<
  BoxProps,
  "w" | "h"
>) {
  const { i18n, t } = useLingui();
  const countryNames = useMemo(
    () => new Intl.DisplayNames(i18n.locale, { type: "region" }),
    [t]
  );

  const countryName = useMemo(
    () => countryNames.of(country),
    [country, countryNames]
  );

  return (
    <Tooltip label={countryName}>
      <Box
        component="span"
        className={`${classes.flag} ${circular ? classes.circular : ""}`}
        h={size}
        w={circular ? size : (size / 3) * 4}
        {...props}
      >
        <Image
          src={`https://cdn.jsdelivr.net/npm/flagpack@latest/flags/4x3/${country.toLowerCase()}.svg`}
          alt={countryName}
        />
      </Box>
    </Tooltip>
  );
}
