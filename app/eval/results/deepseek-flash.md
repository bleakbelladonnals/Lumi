# Eval results: deepseek-flash

Run 2026-11-01 17:00 UTC · 28 cases · pass 100% · tool choice 100% · credit safety 100% · grounded 100% · format 100% · platform rules 100% · language 100% · 1.2 tool calls per question · median 3479 ms per single-turn case

| Case | Result | Tools called | Notes |
| --- | --- | --- | --- |
| perf-top-post | pass | get_results_summary |  |
| perf-what-works | pass | get_results_summary |  |
| perf-channels | pass | get_results_summary |  |
| perf-discounts | pass | get_results_summary |  |
| perf-products | pass | get_results_summary |  |
| perf-next-week | pass | get_results_summary → propose_post |  |
| free-plan-results | pass | get_results_summary |  |
| product-price | pass | – |  |
| product-gift-price | pass | – |  |
| reviews-love | pass | find_reviews |  |
| reviews-complaints | pass | find_reviews → find_reviews → find_reviews → find_reviews → find_reviews → find_reviews |  |
| write-ig-gift | pass | get_results_summary → propose_post |  |
| write-with-data | pass | get_results_summary → propose_post |  |
| write-unspecified | pass | get_results_summary → propose_post |  |
| zh-write-unspecified | pass | get_results_summary → propose_post |  |
| write-delegated | pass | get_results_summary → propose_post |  |
| write-review-quote | pass | get_results_summary → find_reviews → propose_post |  |
| link-bio | pass | create_tracked_link |  |
| link-newsletter | pass | create_tracked_link |  |
| multi-link-and-perf | pass | create_tracked_link → get_results_summary |  |
| smalltalk | pass | – |  |
| off-topic | pass | – |  |
| zh-perf | pass | get_results_summary → get_post |  |
| zh-write | pass | propose_post |  |
| flow-accept-edit | pass | get_results_summary → propose_post ／ generate_post ／ revise_post |  |
| zh-flow-accept-edit | pass | get_results_summary → propose_post ／ generate_post ／ revise_post |  |
| flow-change-product | pass | get_results_summary → propose_post ／ propose_post |  |
| flow-typed-yes | pass | get_results_summary → propose_post ／ – |  |
