import { SpliceSortBy, SpliceSampleType, MusicKey, ChordType, SpliceTag } from "./entities";

export const GRAPHQL_URL = "https://surfaces-graphql.splice.com/graphql"

/**
 * Creates a plain search query, with its only constraint being the filename, as provided
 * via the `query` argument.
 */
export function createSearchRequest(query: string): SpliceSearchRequest {
  return {
    operationName: "SamplesSearch",
    query: 'query SamplesSearch($asset_status_slug: AssetStatusSlug, $page: Int, $order: SortOrder = DESC, $limit: Int = 50, $sort: AssetSortType = relevance, $parent_asset_uuid: GUID, $parent_asset_type: AssetTypeSlug, $query: String, $tags: [ID!], $tags_exclude: [ID!], $attributes: [AssetAttributeSlug!], $key: String, $chord_type: String, $min_bpm: Int, $max_bpm: Int, $bpm: String, $liked: Boolean, $licensed: Boolean, $filepath: String, $asset_category_slug: AssetCategorySlug, $random_seed: String, $coso_seed: CosoSeedInput, $ac_uuid: String, $legacy: Boolean) {\n  assetsSearch(\n    filter: {legacy: $legacy, published: true, asset_type_slug: sample, asset_status_slug: $asset_status_slug, asset_category_slug: $asset_category_slug, query: $query, tag_ids: $tags, tag_ids_exclude: $tags_exclude, attributes: $attributes, key: $key, chord_type: $chord_type, min_bpm: $min_bpm, max_bpm: $max_bpm, bpm: $bpm, liked: $liked, licensed: $licensed, filepath: $filepath, ac_uuid: $ac_uuid, coso_seed: $coso_seed}\n    children: {parent_asset_uuid: $parent_asset_uuid}\n    pagination: {page: $page, limit: $limit}\n    sort: {sort: $sort, order: $order, random_seed: $random_seed}\n    legacy: {parent_asset_type: $parent_asset_type, use: $legacy}\n  ) {\n    ...assetDetails\n    __typename\n  }\n}\n\nfragment assetDetails on AssetPage {\n  ...assetPageItems\n  ...assetTagSummaries\n  ...assetDeviceSummaries\n  pagination_metadata {\n    currentPage\n    totalPages\n    __typename\n  }\n  response_metadata {\n    next\n    previous\n    records\n    __typename\n  }\n  __typename\n}\n\nfragment assetPageItems on AssetPage {\n  items {\n    ... on IAsset {\n      asset_prices {\n        amount\n        currency\n        __typename\n      }\n      uuid\n      name\n      liked\n      licensed\n      asset_type {\n        label\n        __typename\n      }\n      asset_type_slug\n      tags {\n        uuid\n        label\n        taxonomy {\n          uuid\n          name\n          __typename\n        }\n        __typename\n      }\n      files {\n        name\n        hash\n        path\n        asset_file_type_slug\n        url\n        __typename\n      }\n      __typename\n    }\n    ... on IAssetChild {\n      parents(filter: {asset_type_slug: pack}) {\n        items {\n          __typename\n          ... on PackAsset {\n            uuid\n            name\n            permalink_base_url\n            asset_type_slug\n            files {\n              path\n              asset_file_type_slug\n              url\n              __typename\n            }\n            permalink_slug\n            child_asset_counts {\n              type\n              count\n              __typename\n            }\n            main_genre\n            __typename\n          }\n        }\n        __typename\n      }\n      __typename\n    }\n    ... on SampleAsset {\n      uuid\n      name\n      bpm\n      chord_type\n      duration\n      instrument\n      key\n      asset_category_slug\n      has_similar_sounds\n      has_coso\n      attributes\n      coso_playback_metadata {\n        psOffset\n        numBars\n        playbackBpm\n        __typename\n      }\n      __typename\n    }\n    ... on PresetAsset {\n      uuid\n      name\n      attributes\n      device {\n        name\n        uuid\n        plugin_type\n        minimum_device_version\n        __typename\n      }\n      asset_devices {\n        device {\n          name\n          uuid\n          device_type_slug\n          minimum_device_version\n          __typename\n          ... on PluginDevice {\n            plugin_type\n            __typename\n          }\n        }\n        __typename\n      }\n      __typename\n    }\n    ... on PackAsset {\n      uuid\n      name\n      provider {\n        name\n        created_at\n        __typename\n      }\n      provider_uuid\n      uuid\n      permalink_slug\n      permalink_base_url\n      main_genre\n      __typename\n    }\n    ... on ILegacyAsset {\n      catalog_uuid\n      __typename\n    }\n    __typename\n  }\n  __typename\n}\n\nfragment assetTagSummaries on AssetPage {\n  tag_summary {\n    tag {\n      uuid\n      label\n      taxonomy {\n        uuid\n        name\n        __typename\n      }\n      __typename\n    }\n    count\n    __typename\n  }\n  __typename\n}\n\nfragment assetDeviceSummaries on AssetPage {\n  device_summary {\n    device {\n      uuid\n      name\n      __typename\n    }\n    count\n    __typename\n  }\n  __typename\n}\n',
    variables: {
      attributes: [],
      filepath: query,
      legacy: true,
      limit: 50,
      order: "DESC",
      sort: "relevance",
      tags: [],
      tags_exclude: []
    }
  }
}

/**
 * Represents any GraphQL request to Splice.
 */
export interface SpliceRequest<T> {
  operationName: string;
  query: string;
  variables: T;
}

/**
 * Represents a search GraphQL request to Splice.
 */
export interface SpliceSearchRequest extends SpliceRequest<{
  attributes: string[],
  bpm?: string,
  max_bpm?: number,
  min_bpm?: number,
  filepath: string,
  limit: number,
  order: "DESC",
  sort: SpliceSortBy,
  random_seed?: string,
  legacy?: true,
  tags: string[],
  tags_exclude: string[],
  asset_category_slug?: SpliceSampleType,
  page?: number,
  key?: MusicKey,
  chord_type?: ChordType
}>{}

export type SpliceSearchResponse = {
  data: {
    assetsSearch: {
      items: SpliceSample[],
      tag_summary: {
        tag: {
          uuid: string,
          label: string,
          taxonomy: {
            uuid: string;
            name: "Functional Attribute" | "Genre" | "Instrument"
          }
        },
        count: number
      }[],
      response_metadata: {
        records: number
      },
      pagination_metadata: {
        currentPage: number,
        totalPages: number
      }
    }
  }
}

export type SpliceSample = {
  uuid: string,
  name: string,
  tags: SpliceTag[],
  files: SpliceFile[],
  parents: {
    items: SpliceSamplePack[]
  },
  bpm: number | null,
  chord_type: ChordType | null,
  duration: number,
  instrument: string | null,
  key: MusicKey | null,
  asset_category_slug: "oneshot" | "loop"
}

export type SpliceFile = {
  name: string,
  path: string,
  asset_file_type_slug: "preview_mp3" | "waveform",
  url: string
}

export type SpliceSamplePack = {
  uuid: string,
  name: string,
  permalink_base_url: string,
  files: {
    path: string,
    asset_file_type_slug: "cover_image" | "banner_image" | "demo_mp3" | "preview_mp3",
    url: string
  }[]
}
