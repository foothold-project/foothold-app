#pragma once

#include "foothold/runner.hpp"

#include <filesystem>
#include <memory>

namespace foothold {

class OrtPolicy final : public Policy {
public:
    OrtPolicy(const std::filesystem::path& bundle, MapMode mode);
    ~OrtPolicy() override;
    void infer(const Inputs&, Outputs&) override;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

MapMode parse_map_mode(std::string_view value);

}
