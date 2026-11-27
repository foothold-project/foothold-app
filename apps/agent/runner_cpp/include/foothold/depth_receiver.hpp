#pragma once

#include "foothold/runner.hpp"

#include <filesystem>

namespace foothold {

inline constexpr auto depth_freshness = std::chrono::milliseconds(250);

// One datagram, little endian and packed: CLOCK_MONOTONIC nanoseconds (u64), 3600 float32
// policy depths, then the float32 share of cells with no return or outside the image.
// The socket directory is private to the runner's Unix user.
class DepthReceiver {
public:
    explicit DepthReceiver(std::filesystem::path socket_path);
    ~DepthReceiver();
    DepthReceiver(const DepthReceiver&) = delete;
    DepthReceiver& operator=(const DepthReceiver&) = delete;
    const Depth* latest(Tick now, Tick* stamp = nullptr, float* invalid = nullptr);

private:
    std::filesystem::path path_;
    int fd_;
    Tick last_{};
    Depth values_{};
    float invalid_ = 0;
};

}
