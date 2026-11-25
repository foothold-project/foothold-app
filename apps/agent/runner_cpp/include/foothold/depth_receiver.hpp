#pragma once

#include "foothold/runner.hpp"

#include <filesystem>

namespace foothold {

inline constexpr auto depth_freshness = std::chrono::milliseconds(250);

// One datagram: CLOCK_MONOTONIC nanoseconds (u64), followed by 3600 float32s.
// The socket directory is private to the runner's Unix user.
class DepthReceiver {
public:
    explicit DepthReceiver(std::filesystem::path socket_path);
    ~DepthReceiver();
    DepthReceiver(const DepthReceiver&) = delete;
    DepthReceiver& operator=(const DepthReceiver&) = delete;
    const Depth* latest(Tick now, Tick* stamp = nullptr);

private:
    std::filesystem::path path_;
    int fd_;
    Tick last_{};
    Depth values_{};
};

}
