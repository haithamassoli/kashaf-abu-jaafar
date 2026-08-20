const key = Reflect.get(import.meta.env, 'PUBLIC_POSTHOG_KEY') as string | undefined

const client = key
  ? import('posthog-js/dist/module.no-external')
      .then(({ default: posthog }) => {
        posthog.init(key, {
          api_host: 'https://eu.i.posthog.com',
          defaults: '2026-05-30',
          person_profiles: 'never',
          persistence: 'memory',
          autocapture: false,
          capture_pageleave: false,
          capture_dead_clicks: false,
          capture_exceptions: false,
          capture_heatmaps: false,
          capture_performance: false,
          disable_session_recording: true,
          disable_surveys: true,
          advanced_disable_feature_flags: true,
        })
        return posthog
      })
      .catch(() => undefined)
  : undefined

export const track = (event: string, properties?: Record<string, unknown>) => {
  void client?.then((posthog) => posthog?.capture(event, properties))
}
