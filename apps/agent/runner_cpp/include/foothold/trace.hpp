#pragma once

#include "foothold/runner.hpp"

#include <filesystem>
#include <memory>
#include <pthread.h>

namespace foothold {

struct PeriodStats {
    void mark(Tick::duration);
    double p99_ms() const;
    double max_ms() const;
    std::pair<double, double> recent_ms() const;
    std::uint64_t count = 0, over_30_ms = 0;
private:
    // 0.1 ms bins up to 1 s. The last bin also covers larger stalls.
    std::array<std::uint64_t, 10001> histogram_{};
    Tick::duration max_{};
    std::array<double, 250> recent_{};
};

class Trace final : public Observer {
public:
    Trace(std::filesystem::path directory, bool live);
    ~Trace() override;
    void event(Tick, Event, EventInfo) override;
    void sample(const Sample&) override;
    void status(Tick, Phase, std::uint64_t commands, std::uint64_t writes,
                const PeriodStats& policy, const PeriodStats& control, std::uint64_t resyncs,
                const std::optional<Battery>& battery);
    pthread_t thread() const;
    void close();
    bool failed() const;
    std::uint64_t dropped() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}
