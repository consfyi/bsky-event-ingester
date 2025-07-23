import { match } from "@formatjs/intl-localematcher";
import { useLingui } from "@lingui/react/macro";
import {
  Box,
  CloseButton,
  Flex,
  Indicator,
  MantineColor,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import {
  language_script_pairs,
  layers,
  namedFlavor,
} from "@protomaps/basemaps";
import { IconMapPinFilled } from "@tabler/icons-react";
import {
  AttributionControl,
  Map as Maplibre,
  Marker,
  Popup,
  StyleSpecification,
  useMap,
} from "@vis.gl/react-maplibre";
import "maplibre-theme/icons.default.css";
import "maplibre-theme/modern.css";
import { CSSProperties, ReactNode, useMemo } from "react";
import absurd from "~/absurd";
import { hookifyPromise } from "~/hooks";
import classes from "./Map.module.css";

const API_KEY = "a4d6fb59d9d6e179";

const SUPPORTED_LANGUAGES = language_script_pairs.map((v) => v.lang);

function makeStyle({
  colorScheme,
  locale,
}: {
  colorScheme: "light" | "dark";
  locale: string;
}): StyleSpecification {
  const flavorName =
    colorScheme == "light"
      ? "white"
      : colorScheme == "dark"
      ? "black"
      : absurd<string>(colorScheme);
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
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${flavorName}`,
    layers: layers("protomaps", namedFlavor(flavorName), {
      lang: match([locale], SUPPORTED_LANGUAGES, "en"),
    }),
    transition: { duration: 0, delay: 0 },
  };
}

export interface Pin {
  id: string;
  lat: number;
  lng: number;
  variant: string;
  color: MantineColor;
  active: boolean;
  zIndex: number;
  popup: ReactNode;
}

function MarkupWithPopup({
  pin,
  showPopup,
  setShowPopup,
}: {
  pin: Pin;
  showPopup: boolean;
  setShowPopup: (v: boolean) => void;
}) {
  const theme = useMantineTheme();

  const colors = theme.variantColorResolver({
    theme,
    color: pin.color,
    variant: pin.variant,
  });

  const mapRef = useMap();

  return (
    <>
      <Marker
        latitude={pin.lat}
        longitude={pin.lng}
        onClick={(e) => {
          e.originalEvent.stopPropagation();
          if (mapRef.current != null && showPopup) {
            mapRef.current.flyTo({ center: [pin.lng, pin.lat] });
          }
          setShowPopup(true);
        }}
        style={{
          zIndex: pin.zIndex,
        }}
        subpixelPositioning
      >
        <Box style={{ marginTop: "-100%" }}>
          <Indicator
            position="top-start"
            color="green"
            processing
            size={12}
            withBorder
            disabled={!pin.active}
            zIndex={2}
            offset={6}
          >
            <IconMapPinFilled
              size={32}
              color={
                pin.variant == "light"
                  ? `color-mix(in srgb, var(--mantine-color-${pin.color}-filled), var(--mantine-color-body) 90%)`
                  : colors.background
              }
              style={{
                stroke: colors.color,
              }}
            />
          </Indicator>
        </Box>
      </Marker>
      {showPopup ? (
        <Popup
          closeButton={false}
          closeOnClick={false}
          focusAfterOpen={false}
          maxWidth="none"
          latitude={pin.lat}
          longitude={pin.lng}
          style={{ zIndex: 100 }}
        >
          <Flex gap="xs">
            {pin.popup}
            <CloseButton
              onClick={() => {
                setShowPopup(false);
              }}
            />
          </Flex>
        </Popup>
      ) : null}
    </>
  );
}

async function getMyLocation(
  signal?: AbortSignal
): Promise<{ lat: number; lng: number }> {
  const resp = await fetch("https://free.freeipapi.com/api/json", {
    signal,
  });
  if (!resp.ok) {
    throw resp;
  }
  const { latitude, longitude } = await resp.json();
  return { lat: latitude, lng: longitude };
}

const useMyLocation = hookifyPromise(
  (async () => {
    const ctrl = new AbortController();
    setTimeout(() => {
      ctrl.abort();
    }, 1000);
    try {
      return await getMyLocation(ctrl.signal);
    } catch {
      return null;
    }
  })()
);

export default function Map({
  pins,
  style,
  initialCenter,
  setCenter,
  selected,
  setSelected,
}: {
  pins: Pin[];
  style: CSSProperties;
  initialCenter: { lat: number; lng: number; zoom: number } | null;
  setCenter(center: { lat: number; lng: number; zoom: number }): void;
  selected: string | null;
  setSelected(selected: string | null): void;
}) {
  const colorScheme = useComputedColorScheme();
  const { i18n, t } = useLingui();

  const myLatLng = useMyLocation();

  const center =
    initialCenter != null
      ? initialCenter
      : myLatLng != null
      ? { ...myLatLng, zoom: 3 }
      : { lat: 0, lng: 0, zoom: 0 };

  const mapStyle = useMemo(
    () => makeStyle({ colorScheme, locale: i18n.locale }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colorScheme, t]
  );

  return (
    <Box
      className={`${colorScheme} ${classes.map}`}
      style={{ position: "relative", height: "100%", zIndex: 0 }}
    >
      <Maplibre
        ref={(ref) => {
          if (ref == null) {
            return;
          }
          const map = ref.getMap();
          map.dragRotate.disable();
          map.touchPitch.disable();
          map.touchZoomRotate.disableRotation();
          map.keyboard.disableRotation();
        }}
        onMoveEnd={(e) => {
          setCenter({
            lat: e.viewState.latitude,
            lng: e.viewState.longitude,
            zoom: e.viewState.zoom,
          });
        }}
        onClick={() => {
          setSelected(null);
        }}
        initialViewState={{
          latitude: center.lat,
          longitude: center.lng,
          zoom: center.zoom,
        }}
        attributionControl={false}
        mapStyle={mapStyle}
        style={style}
      >
        <AttributionControl compact={false} />
        {pins.map((pin, i) => (
          <MarkupWithPopup
            key={i}
            pin={pin}
            showPopup={pin.id == selected}
            setShowPopup={(v) => {
              setSelected(v ? pin.id : null);
            }}
          />
        ))}
      </Maplibre>
    </Box>
  );
}
