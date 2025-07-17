import { useLingui } from "@lingui/react/macro";
import { Box, useComputedColorScheme, useMantineTheme } from "@mantine/core";
import { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { IconMapPinFilled } from "@tabler/icons-react";
import {
  AttributionControl,
  Map as Maplibre,
  Marker,
  MarkerEvent,
  Popup,
} from "@vis.gl/react-maplibre";
import { getDay } from "date-fns";
import maplibregl from "maplibre-gl";
import "maplibre-theme/icons.default.css";
import "maplibre-theme/modern.css";
import { useMemo, useState } from "react";
import { ConWithPost } from "~/hooks";
import { ConRow } from "./ConsList";

const API_KEY = "a4d6fb59d9d6e179";

function makeStyle({
  colorScheme,
  locale,
}: {
  colorScheme: "light" | "dark";
  locale: string;
}): StyleSpecification {
  const loc = new Intl.Locale(locale);

  return {
    version: 8,
    sources: {
      openmaptiles: {
        type: "vector",
        url: `https://api.protomaps.com/tiles/v4.json?key=${API_KEY}`,
        attribution:
          "<a href='https://openstreetmap.org/copyright'>© OpenStreetMap Contributors</a>",
      },
    },
    glyphs:
      "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${colorScheme}`,
    layers: layers("openmaptiles", namedFlavor(colorScheme), {
      lang: loc.language,
    }),
  };
}

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
        <Popup
          maxWidth="none"
          latitude={lat}
          longitude={lng}
          offset={[0, -12]}
          style={{ zIndex: 100 }}
        >
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
        mapLib={maplibregl}
        onClick={() => {
          setSelected(null);
        }}
        initialViewState={{
          latitude: 0,
          longitude: 0,
          zoom: 0,
        }}
        attributionControl={false}
        mapStyle={style}
        style={{
          height: "100%",
          zIndex: 0,
          ...{
            "--ml-c-bg-1": "var(--mantine-color-default)",
            "--ml-ctrl-border-radius": "var(--mantine-radius-default)",
            "--ml-shadow": "none",
            "--ml-c-link-1": "var(--mantine-color-dimmed)",
          },
        }}
      >
        <AttributionControl
          compact={false}
          style={{
            background: "none",
            fontSize: "var(--mantine-font-size-xs)",
            borderTopLeftRadius: "var(--mantine-radius-default)",
            fontWeight: 500,
          }}
        />
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
