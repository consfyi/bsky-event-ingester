import { useLingui } from "@lingui/react/macro";
import { Box, useComputedColorScheme, useMantineTheme } from "@mantine/core";
import { IconMapPinFilled } from "@tabler/icons-react";
import {
  Map as Maplibre,
  Marker,
  MarkerEvent,
  Popup,
} from "@vis.gl/react-maplibre";
import { getDay } from "date-fns";
import "maplibre-theme/icons.default.css";
import "maplibre-theme/modern.css";
import { useMemo, useState } from "react";
import { ConWithPost } from "~/hooks";
import { ConRow } from "./ConsList";
import makeStyle from "./Map/style";

function Pin({
  con,
  showPopup,
  onClick,
  zIndex,
}: {
  con: ConWithPost;
  showPopup: boolean;
  onClick?(e: MarkerEvent<MouseEvent>): void;
  zIndex: number;
}) {
  const theme = useMantineTheme();

  const latLng = con.geocoded?.latLng;
  if (latLng == null) {
    return null;
  }
  const [lat, lng] = latLng;

  const color = [
    "red",
    "orange",
    "yellow",
    "green",
    "blue",
    "indigo",
    "violet",
  ][getDay(con.start)];

  const variant =
    con.post.viewer != null && con.post.viewer.like != null
      ? "filled"
      : "light";

  const colors = theme.variantColorResolver({
    theme,
    color,
    variant,
  });

  return (
    <>
      <Marker
        latitude={lat}
        longitude={lng}
        onClick={onClick}
        style={{ zIndex }}
      >
        <IconMapPinFilled
          size={32}
          color={
            variant == "light"
              ? `color-mix(in srgb, var(--mantine-color-${color}-filled), var(--mantine-color-body) 90%)`
              : colors.background
          }
          style={{
            stroke: colors.color,
            marginTop: "-100%",
          }}
        />
      </Marker>
      {showPopup ? (
        <Popup latitude={lat} longitude={lng} offset={[0, -14]}>
          <ConRow
            con={con}
            showMonthInIcon
            showEndDateOnly={false}
            showLocation={false}
            showFollowed
            showLikeButton
            showBigIcon={false}
            showDuration={false}
          />
        </Popup>
      ) : null}
    </>
  );
}

export default function Map({ cons }: { cons: ConWithPost[] }) {
  const colorScheme = useComputedColorScheme();
  const { i18n, t } = useLingui();
  const [selected, setSelected] = useState<string | null>();

  const style = useMemo(
    () => makeStyle({ colorScheme, locale: i18n.locale }),
    [colorScheme, t]
  );

  return (
    <Box className={colorScheme} style={{ height: "100%" }}>
      <Maplibre
        onClick={() => {
          setSelected(null);
        }}
        initialViewState={{
          latitude: 0,
          longitude: 0,
          zoom: 2,
        }}
        mapStyle={style}
        style={{ height: "100%" }}
      >
        {cons.map((con) => (
          <Pin
            key={con.slug}
            con={con}
            showPopup={con.slug == selected}
            onClick={(e) => {
              e.originalEvent.stopPropagation();
              setSelected(con.slug);
            }}
            zIndex={
              con.post.viewer != null && con.post.viewer.like != null ? 1 : 0
            }
          />
        ))}
      </Maplibre>
    </Box>
  );
}
