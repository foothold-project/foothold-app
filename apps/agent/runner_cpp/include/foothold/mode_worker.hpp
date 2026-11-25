#pragma once

#include "foothold/runner.hpp"

#include <memory>

namespace foothold {

// One caller submits and polls. Only the worker calls mode and gait RPCs.
class ModeWorker final : public ModeExecutor {
public:
    explicit ModeWorker(Robot&);
    ~ModeWorker() override;
    void submit(ModeRequest) override;
    std::optional<ModeResult> poll() override;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}
