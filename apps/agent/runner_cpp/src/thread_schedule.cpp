#include "foothold/thread_schedule.hpp"

#include <cerrno>
#include <iostream>
#include <stdexcept>
#include <system_error>

namespace foothold {
namespace {
void check(int error, const char* operation) {
    if (error) throw std::system_error(error, std::generic_category(), operation);
}
}

cpu_set_t allowed_cpus() {
    cpu_set_t cpus;
    check(pthread_getaffinity_np(pthread_self(), sizeof(cpus), &cpus), "get CPU affinity");
    return cpus;
}

cpu_set_t select_cpus(const cpu_set_t& allowed, CpuRange range, bool require_all) {
    cpu_set_t selected;
    CPU_ZERO(&selected);
    for (int cpu = range.first; cpu <= range.last; ++cpu) {
        if (CPU_ISSET(cpu, &allowed)) CPU_SET(cpu, &selected);
        else if (require_all) throw std::invalid_argument("CPU partition includes an unavailable CPU");
    }
    if (!CPU_COUNT(&selected)) throw std::invalid_argument("no requested CPUs available in current affinity");
    return selected;
}

bool overlaps(const cpu_set_t& a, const cpu_set_t& b) {
    cpu_set_t shared;
    CPU_AND(&shared, &a, &b);
    return CPU_COUNT(&shared) != 0;
}

void pin_thread(const cpu_set_t& cpus) {
    check(pthread_setaffinity_np(pthread_self(), sizeof(cpus), &cpus), "set CPU affinity");
    const auto actual = allowed_cpus();
    if (!CPU_EQUAL(&actual, &cpus)) throw std::runtime_error("kernel partially applied CPU affinity");
}

void normal_thread() {
    const sched_param params{};
    check(pthread_setschedparam(pthread_self(), SCHED_OTHER, &params), "set SCHED_OTHER");
}

void name_thread(const char* name) {
    pthread_setname_np(pthread_self(), name);
}

bool set_fifo(int priority) {
    if (priority == 0) return false;
    sched_param params{};
    params.sched_priority = priority;
    return pthread_setschedparam(pthread_self(), SCHED_FIFO, &params) == 0;
}

void report_schedule(const char* role, pthread_t thread, int requested_priority) {
    cpu_set_t cpus;
    sched_param params{};
    int policy;
    check(pthread_getaffinity_np(thread, sizeof(cpus), &cpus), "read role CPU affinity");
    check(pthread_getschedparam(thread, &policy, &params), "read role scheduling policy");
    const auto* name = policy == SCHED_FIFO ? "SCHED_FIFO" :
                       policy == SCHED_OTHER ? "SCHED_OTHER" :
                       policy == SCHED_RR ? "SCHED_RR" : "other";
    std::cout << "{\"role\":\"" << role << "\",\"cpus\":[";
    bool first = true;
    for (int cpu = 0; cpu < CPU_SETSIZE; ++cpu) {
        if (!CPU_ISSET(cpu, &cpus)) continue;
        if (!first) std::cout << ',';
        first = false;
        std::cout << cpu;
    }
    std::cout << "],\"policy\":\"" << name << "\",\"priority\":" << params.sched_priority
              << ",\"requested_priority\":" << requested_priority << "}\n";
}

}
