import { useLingui } from "@lingui/react/macro";
import { Box, useComputedColorScheme, useMantineTheme } from "@mantine/core";
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
import maplibregl, { StyleSpecification } from "maplibre-gl";
import "maplibre-theme/icons.default.css";
import "maplibre-theme/modern.css";
import { useMemo, useState } from "react";
import { ConWithPost, hookifyPromise } from "~/hooks";
import { ConRow } from "./ConsList";
import classes from "./Map.module.css";

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
      protomaps: {
        type: "vector",
        url: `https://api.protomaps.com/tiles/v4.json?key=${API_KEY}`,
        attribution:
          '<a href="https://openstreetmap.org/copyright" target="_blank">© OpenStreetMap Contributors</a>',
      },
    },
    glyphs:
      "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${colorScheme}`,
    layers: layers("protomaps", namedFlavor(colorScheme), {
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

async function getMyLocation(
  signal?: AbortSignal
): Promise<{ latitude: number; longitude: number }> {
  const resp = await fetch("https://free.freeipapi.com/api/json", {
    signal,
  });
  if (!resp.ok) {
    throw resp;
  }
  return (await resp.json()) as {
    latitude: number;
    longitude: number;
  };
}

const useMyLocation = hookifyPromise(
  (async () => {
    const ctrl = new AbortController();
    setTimeout(() => {
      ctrl.abort();
    }, 1000);
    try {
      return { ok: true, latLon: await getMyLocation(ctrl.signal) };
    } catch {
      return { ok: false };
    }
  })()
);

export default function Map({ cons }: { cons: ConWithPost[] }) {
  const colorScheme = useComputedColorScheme();
  const { i18n, t } = useLingui();
  const [selected, setSelected] = useState<string | null>();

  const r = useMyLocation();
  const { latitude, longitude, zoom } = r.ok
    ? { ...r.latLon, zoom: 3 }
    : { latitude: 0, longitude: 0, zoom: 0 };

  const style = useMemo(
    () => makeStyle({ colorScheme, locale: i18n.locale }),
    [colorScheme, t]
  );

  return (
    <Box className={`${colorScheme} ${classes.map}`} style={{ height: "100%" }}>
      <Maplibre
        mapLib={maplibregl}
        onClick={() => {
          setSelected(null);
        }}
        initialViewState={{
          latitude,
          longitude,
          zoom,
        }}
        attributionControl={false}
        mapStyle={style}
        style={{
          height: "100%",
          zIndex: 0,
        }}
      >
        <AttributionControl
          compact={false}
          style={{
            background: "none",
            fontSize: "var(--mantine-font-size-xs)",
            borderTopLeftRadius: "var(--mantine-radius-default)",
            fontWeight: 500,
            WebkitTextStroke: "0.1px",
            WebkitTextStrokeColor: "var(--mantine-color-default)",
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
